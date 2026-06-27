// Compile a Pyret CST (from the reused parser) to a WASM-GC module via binaryen.
//
// Values flow as `anyref`. Reps: numbers (ref $Num) subtypes; booleans/nothing
// as i31 (true=1,false=0,nothing=2); strings ($Str=array i8); data variants
// ($Variant); functions are closures ($Closure { fnIndex:i32, caps }).
//
// Calling convention (uniform): every Pyret function compiles to a wasm function
// (closure: $Closure, args: $Fields|null) -> anyref. Calls go through a function
// table via call_indirect / return_call_indirect (tail). First-class functions
// and closures fall out naturally; named recursion still gets proper tail calls.

import binaryen from "binaryen";
import type { CstNode } from "../parser/pyret-parser.ts";
import { buildTypes, type RtTypes, FEATURES } from "./types.ts";
import { Runtime, SCRATCH_OFFSET, GAS_RESET } from "./runtime.ts";

export class CompileError extends Error {
  node?: CstNode;
  constructor(message: string, node?: CstNode) {
    super(message);
    this.name = "CompileError";
    this.node = node;
  }
}

interface VariantInfo { id: number; fields: string[]; refs?: boolean[]; methods?: { name: string; node: CstNode }[]; ownVariants?: string[]; order?: number; }

const ARITH_FN: Record<string, string> = {
  PLUS: "$num_add", DASH: "$num_sub", TIMES: "$num_mul", SLASH: "$num_divide",
};
const CMP: Record<string, (c: number, m: binaryen.Module) => number> = {
  LT: (c, m) => m.i32.lt_s(c, m.i32.const(0)),
  GT: (c, m) => m.i32.gt_s(c, m.i32.const(0)),
  LEQ: (c, m) => m.i32.le_s(c, m.i32.const(0)),
  GEQ: (c, m) => m.i32.ge_s(c, m.i32.const(0)),
};
// Pyret binary operators desugar to method calls when the LHS is not a number/
// string: `a + b` -> `a._plus(b)`, etc. (so data/objects can overload operators).
const OP_METHOD: Record<string, string> = {
  PLUS: "_plus", DASH: "_minus", TIMES: "_times", SLASH: "_divide",
  LT: "_lessthan", GT: "_greaterthan", LEQ: "_lessequal", GEQ: "_greaterequal",
};

// Per-function compilation context.
class Ctx {
  params = new Map<string, number>();   // name -> index in args array
  captures = new Map<string, number>(); // name -> index in caps array
  locals = new Map<string, number>();   // name -> wasm local index
  boxed = new Set<string>();            // names held in a 1-cell mutable box (var captured by a closure)
  localTypes: binaryen.Type[] = [];
  base: number;                         // first free wasm local index
  constructor(public isMain: boolean) {
    // non-main functions reserve local 0 (closure) and 1 (args)
    this.base = isMain ? 0 : 2;
  }
  addLocal(type: binaryen.Type): number {
    const idx = this.base + this.localTypes.length;
    this.localTypes.push(type);
    return idx;
  }
}

class Compiler {
  m: binaryen.Module;
  t: RtTypes;
  variants = new Map<string, VariantInfo>();
  // While compiling a data type's method bodies, its own variant constructors win
  // over any top-level `shadow` of the same name (e.g. pprint's _plus uses the
  // `concat` VARIANT even though `shadow concat = lam(a,b): a + b end` exists).
  private methodVariantScope: Set<string> | null = null;
  nextVariantId = 1;
  topScope = new Map<string, string>(); // pyret name -> wasm global name
  moduleAliases = new Set<string>();    // `import lib as N` -> N (resolved to globals)
  fnNames: string[] = [];               // table entries (index = position)
  ctorFns = new Map<string, number>();  // variant name -> table index of its constructor wrapper
  predFns = new Map<string, number>();  // variant name -> table index of its is-<v> predicate wrapper
  typePredFns = new Map<string, number>(); // data TYPE name -> table index of its is-<Type> predicate
  dataTypeRanges = new Map<string, { min: number; max: number }>(); // data type name -> [min,max] variant id range
  tostringFns = new Map<string, number>(); // tostring/torepr reified as first-class fns
  sig: binaryen.Type;
  gcount = 0;                            // for unique global names
  stoppable = false;                    // stoppable codegen (CPS-transformed input)
  // Top-level `let`s that re-bind an already-global name -> the prior global, so the
  // RHS resolves to it (non-recursive let; see pass 1). Keyed by the let-expr node.
  topLetPrior = new Map<CstNode, string>();
  // The global each top-level let allocated for ITS binding. With duplicate names
  // across modules, topScope only holds the last, so the assignment target must come
  // from here (else an earlier same-named binding writes to a later binding's global,
  // leaving its own global null).
  topLetGlobal = new Map<CstNode, string>();
  // FIRST global allocated for each top-level name. A module-alias member access
  // `N.foo` refers to module N's export of `foo` — the original definition, which
  // (since imports are loaded before the importing module) is the first-registered
  // global. Using topScope (last-wins) would instead pick up an importing module's
  // same-named local rebind (e.g. `t-string = T.t-string(...)`), which is defined
  // later in program order and thus still null at earlier use sites.
  firstGlobal = new Map<string, string>();
  // Program-order resolution. Each top-level name may be bound several times across
  // the flattened module list; globalGens records ALL bindings of a name in order.
  // A reference compiled at `resolveOrder` resolves to the most-recent binding at or
  // before it (lexical/program order), falling back to the FIRST for forward refs.
  // This stops a LATER module's `shadow map = lam ...: lst.map(...)` from capturing
  // the prelude's own `map` recursion (which would loop forever). Default Infinity =
  // see everything (last-wins), used for the entry program's own top-level code.
  globalGens = new Map<string, { order: number; gname: string; mod: number }[]>();
  resolveOrder = Infinity;   // order of the top-level item currently being compiled
  curOrder = 0;              // order being assigned during pass-1 registration
  stmtOrder = new Map<CstNode, number>(); // top-level stmt node -> its program-order index
  // ---- module-awareness (whole-program flattening) ----
  // Two modules can export the SAME top-level name (e.g. a `fun foo` in one, a `data`
  // variant `foo` in another). The flat namespace would alias them; these tables let
  // `N.member` resolve to the SPECIFIC module the alias names, and let cross-module
  // shadowing (a later module's `fun foo` shadowing an earlier module's `foo` variant)
  // be decided correctly. All optional: empty => legacy first/last-wins behavior.
  stmtMod = new WeakMap<CstNode, number>();           // top-level stmt node -> module id
  aliasMap = new Map<number, Map<string, number>>();  // importerMod -> (alias -> targetMod)
  orderToMod = new Map<number, number>();             // top-level order index -> module id
  curMod = 0;                                         // module id during pass-1 registration
  // Every variant generation by name, with its defining module (parallels globalGens;
  // `variants` itself stays last-wins for the existing arity-based dispatch).
  variantGens = new Map<string, { info: VariantInfo; mod: number }[]>();

  constructor() {
    this.m = new binaryen.Module();
    this.m.setFeatures(FEATURES);
    this.t = buildTypes();
    this.m.setMemory(1, 256, "memory");
    new Runtime(this.m, this.t).build();
    this.sig = binaryen.createType([this.t.ClosureRef, this.t.FieldsRefNull]);
  }

  // ---- CST helpers ----
  private only(node: CstNode): CstNode {
    if (node.kids.length !== 1) throw new CompileError(`expected single child of ${node.name}`, node);
    return node.kids[0]!;
  }
  private childNamed(node: CstNode, name: string): CstNode | undefined {
    return node.kids.find((k) => k.name === name);
  }
  private stmtInner(stmt: CstNode): CstNode { return this.only(stmt); }

  compileProgram(program: CstNode): Uint8Array {
    if (program.name !== "program") throw new CompileError("expected program", program);
    const block = this.childNamed(program, "block");
    if (!block) throw new CompileError("no block in program");
    // Registry of data-variant methods, indexed by variant id (filled in $main).
    this.m.addGlobal("$variant_methods", this.t.FieldsRefNull, true, this.m.ref.null(this.t.FieldsRefNull));
    // Registry of data-variant field NAMES (a $Names array per variant id), for
    // runtime field-access-by-name (filled in $main).
    this.m.addGlobal("$variant_names", this.t.FieldsRefNull, true, this.m.ref.null(this.t.FieldsRefNull));
    const m = this.m;
    const stmts = block.kids.filter((k) => k.name === "stmt");

    // Process imports (prelude section). Our stdlib is already global, so an
    // `import lib as N` just records N as a module alias; `N.foo` resolves to the
    // global `foo`. `include` and `import names from` are no-ops (already global).
    this.processImports(this.childNamed(program, "prelude"));

    // Pass 1: register data declarations + top-level names (funs and lets) as
    // globals so they may be forward/mutually referenced.
    const topFuns: { node: CstNode; gname: string; fnIndex: number; wasmName: string; order: number }[] = [];
    for (let si = 0; si < stmts.length; si++) {
      const stmt = stmts[si]!;
      this.curOrder = si; // program-order index for this top-level statement
      this.curMod = this.stmtMod.get(stmt) ?? 0; // module this statement came from
      this.orderToMod.set(si, this.curMod);
      this.stmtOrder.set(stmt, si);
      const inner = this.stmtInner(stmt);
      if (inner.name === "data-expr") { this.registerData(inner); continue; }
      if (inner.name === "fun-expr") {
        const name = this.childNamed(inner, "NAME")!.value!;
        const gname = this.freshGlobal(name);
        const fnIndex = this.fnNames.length;
        const wasmName = "$fn_" + this.gcount + "_" + name;
        this.fnNames.push(wasmName);
        topFuns.push({ node: inner, gname, fnIndex, wasmName, order: si });
      } else if (inner.name === "let-expr" || inner.name === "var-expr" || inner.name === "rec-expr") {
        const nm = this.bindingName(this.letBinding(inner));
        // Whole-program flattening puts every module's top-level names in one global
        // scope, so a module re-binding a name the prelude/another module already
        // defines (e.g. `fold_n = LISTS.fold_n`, `string-dict = SD.string-dict`)
        // collides. Pyret `let` is non-recursive: such a binding's RHS must see the
        // PRIOR binding (the real lists/string-dict export), not the new global it is
        // defining (which is still null at that point -> a self-referential crash).
        const prior = this.topScope.get(nm);
        const gname = this.freshGlobal(nm);
        this.topLetGlobal.set(inner, gname);
        if (prior !== undefined) this.topLetPrior.set(inner, prior);
      }
    }

    // Pass 2: compile top-level function bodies (no captures). Each function resolves
    // names as of its own program position, so a prelude function's recursion binds to
    // the prelude's globals, not a later module's same-named `shadow`.
    for (const tf of topFuns) {
      this.resolveOrder = tf.order;
      this.compileFunction(tf.wasmName, tf.node, new Map());
    }
    this.resolveOrder = Infinity;

    // Pass 3: $main — initialize fun globals (hoisted), then run statements.
    const ctx = new Ctx(true);
    // Box top-level vars captured+assigned by a nested closure (e.g. a `var` inside
    // a `block:` expression). Top-level *statement* vars are globals (shared already),
    // so exclude those — only nested-block locals need a shared cell.
    for (const n of this.boxedVarsFor(block!)) {
      if (!this.topScope.has(n)) ctx.boxed.add(n);
    }
    const resultLocal = ctx.addLocal(binaryen.anyref);
    const lenLocal = ctx.addLocal(binaryen.i32);
    const body: number[] = [];
    // Inform the renderer of List's link/empty ids so lists show as [list: ...].
    const linkV = this.variants.get("link");
    const emptyV = this.variants.get("empty");
    if (linkV) body.push(m.global.set("$link_id", m.i32.const(linkV.id)));
    if (emptyV) body.push(m.global.set("$empty_id", m.i32.const(emptyV.id)));
    for (const tf of topFuns) {
      body.push(m.global.set(tf.gname, this.makeClosure(tf.fnIndex, [], ctx)));
    }
    // Build the data-variant method registry: $variant_methods[id] = methods object.
    this.initVariantMethods(ctx, body);
    // Build the data-variant field-name registry: $variant_names[id] = $Names array.
    this.initVariantNames(ctx, body);
    const skipTop = new Set(["fun-expr", "data-expr", "type-expr", "newtype-expr", "contract-stmt"]);
    const runnable = stmts.filter((s) => !skipTop.has(this.stmtInner(s).name));
    let printed = false;
    runnable.forEach((stmt, i) => {
      const inner = this.stmtInner(stmt);
      const order = this.stmtOrder.get(stmt) ?? Infinity;
      if (inner.name === "let-expr" || inner.name === "var-expr" || inner.name === "rec-expr") {
        const name = this.bindingName(this.letBinding(inner));
        // Assign to THIS binding's own global (not topScope's last-wins entry).
        const gname = this.topLetGlobal.get(inner) ?? this.topScope.get(name)!;
        // Non-recursive let: its RHS sees bindings strictly BEFORE it (so a re-binding
        // like `shadow x = <expr using x>` reads the prior x, not the new global). A
        // `rec` binding is recursive and may see itself.
        this.resolveOrder = inner.name === "rec-expr" ? order : order - 1;
        const rhs = this.compileExpr(inner.kids[inner.kids.length - 1]!, ctx, false);
        this.resolveOrder = Infinity;
        body.push(m.global.set(gname, rhs));
      } else if (inner.name === "check-expr") {
        this.resolveOrder = order;
        body.push(this.compileCheckExpr(inner, ctx));
        this.resolveOrder = Infinity;
      } else if (inner.name === "check-test" && inner.kids.length > 1) {
        this.resolveOrder = order;
        body.push(this.compileCheckTest(inner, ctx));
        this.resolveOrder = Infinity;
      } else {
        this.resolveOrder = order;
        const value = this.compileExpr(inner, ctx, false);
        this.resolveOrder = Infinity;
        if (i === runnable.length - 1) { body.push(m.local.set(resultLocal, value)); printed = true; }
        else body.push(m.drop(value));
      }
    });
    // In stoppable (CPS) mode the trailing expression's continuation is
    // `finish-result`, which prints the value itself — so $main must not also
    // auto-print (it would emit "nothing", the value of the CPS expression).
    if (printed && !this.stoppable) {
      body.push(m.local.set(lenLocal, m.call("$val_to_string", [m.local.get(resultLocal, binaryen.anyref)], binaryen.i32)));
      body.push(m.call("$print", [m.i32.const(SCRATCH_OFFSET), m.local.get(lenLocal, binaryen.i32)], binaryen.none));
    }
    body.push(m.call("$check_summary",
      [m.global.get("$passed", binaryen.i32), m.global.get("$total", binaryen.i32)], binaryen.none));
    m.addFunction("$main", binaryen.none, binaryen.none, ctx.localTypes, m.block(null, body));
    m.addFunctionExport("$main", "main");

    // Export that runs the pending `raises` thunk (host calls it in try/catch).
    {
      const tctx = new Ctx(true); // no params -> locals start at 0
      const callIt = this.callClosureValue(m.global.get("$pending_thunk", binaryen.anyref), [], tctx, false);
      m.addFunction("$run_pending_thunk", binaryen.none, binaryen.anyref, tctx.localTypes, callIt);
      m.addFunctionExport("$run_pending_thunk", "run_pending_thunk");
    }

    // Stoppable codegen: resume a paused computation by tail-calling the captured
    // continuation thunk. The host (trampoline driver) calls this after each pause.
    {
      const tctx = new Ctx(true);
      const resumeIt = this.callClosureValue(m.global.get("$paused_thunk", binaryen.anyref), [], tctx, true);
      m.addFunction("$resume", binaryen.none, binaryen.anyref, tctx.localTypes, resumeIt);
      m.addFunctionExport("$resume", "resume");
    }

    // Function table for call_indirect. Always present (even when empty) so the
    // $resume / $run_pending_thunk exports validate in programs with no functions.
    m.addTable("$tab", this.fnNames.length, this.fnNames.length);
    if (this.fnNames.length > 0) {
      m.addActiveElementSegment("$tab", "$seg", this.fnNames, m.i32.const(0));
    }
    // $variant_match (Pyret's `_match`, the basis of `.visit()`) lives here rather
    // than in the standalone runtime because it uses the `$tab` function table.
    this.emitVariantMatch();

    if (!m.validate()) throw new CompileError("generated module failed validation");
    if (typeof process !== "undefined" && process.env?.PYRET_DUMP) console.error(m.emitText());
    return m.emitBinary();
  }

  // Allocate a fresh unique wasm global for a top-level pyret name (last
  // definition of a name wins, so redefinitions don't collide).
  private freshGlobal(name: string): string {
    const gname = "$g" + (this.gcount++) + "_" + name;
    this.m.addGlobal(gname, binaryen.anyref, true, this.m.ref.null(binaryen.anyref));
    this.topScope.set(name, gname);
    if (!this.firstGlobal.has(name)) this.firstGlobal.set(name, gname);
    const gens = this.globalGens.get(name) ?? [];
    gens.push({ order: this.curOrder, gname, mod: this.curMod });
    this.globalGens.set(name, gens);
    return gname;
  }

  // The wasm global for `name` defined by MODULE `mod` (module-aware `N.member`).
  private globalForMod(name: string, mod: number): string | undefined {
    const gens = this.globalGens.get(name);
    if (!gens) return undefined;
    const hit = gens.find((g) => g.mod === mod);
    return hit?.gname;
  }

  // The global for `name` visible to code at `this.resolveOrder`: the most-recent
  // binding at or before that order, else the first (forward references). With the
  // default resolveOrder=Infinity this is the last binding (= topScope).
  private globalFor(name: string): string | undefined {
    const gens = this.globalGens.get(name);
    if (!gens || gens.length === 0) return this.topScope.get(name);
    if (gens.length === 1) return gens[0]!.gname;
    let best: string | undefined;
    for (const g of gens) { if (g.order <= this.resolveOrder) best = g.gname; else break; }
    return best ?? gens[0]!.gname;
  }

  // `N.member` (module-alias access) -> module N's export of `member`. When we know
  // which module the alias `N` names (aliasMap), resolve to THAT module's global, so
  // two modules exporting the same name don't collide. Otherwise fall back to the
  // first-registered global (the original definition, before any importer's rebind).
  private resolveModuleMember(name: string, alias: string | null, ctx: Ctx): number | null {
    const tgt = this.moduleTargetFor(alias);
    if (tgt !== undefined) {
      const g = this.globalForMod(name, tgt);
      if (g !== undefined) return this.m.global.get(g, binaryen.anyref);
    }
    const fg = this.firstGlobal.get(name);
    if (fg !== undefined) return this.m.global.get(fg, binaryen.anyref);
    return this.resolveName(name, ctx);
  }

  // ---- data ----
  private registerData(dataExpr: CstNode) {
    // `sharing:` methods apply to every variant of this data type; per-variant
    // `with:` methods override them by name.
    // The variants of one `data` decl get consecutive ids, so the type is a
    // contiguous id range — record it for the data-TYPE predicate `is-<TypeName>`.
    const typeName = this.childNamed(dataExpr, "NAME")?.value;
    const minId = this.nextVariantId;
    const sharing = this.childNamed(dataExpr, "data-sharing");
    const shared = sharing ? this.collectMethods(sharing) : [];
    const variantKids = dataExpr.kids.filter((k) => k.name === "first-data-variant" || k.name === "data-variant");
    // All constructor names of this data decl — its methods resolve these to the
    // variants even when a later top-level `shadow` rebinds the same name.
    const ownVariants = variantKids.map((kid) => {
      const ctor = this.childNamed(kid, "variant-constructor");
      return ctor ? this.childNamed(ctor, "NAME")!.value! : this.childNamed(kid, "NAME")!.value!;
    });
    for (const kid of variantKids) {
      const own = this.collectMethods(this.childNamed(kid, "data-with"));
      const byName = new Map<string, { name: string; node: CstNode }>();
      for (const s of shared) byName.set(s.name, s);
      for (const o of own) byName.set(o.name, o);
      const methods = [...byName.values()];
      const ctor = this.childNamed(kid, "variant-constructor");
      if (ctor) {
        const name = this.childNamed(ctor, "NAME")!.value!;
        const members = this.childNamed(ctor, "variant-members");
        const memberNodes = members ? members.kids.filter((k) => k.name === "variant-member") : [];
        const fields = memberNodes.map((vm) => this.bindingName(this.childNamed(vm, "binding")!));
        // a `ref`-annotated member (`bx(ref v, w)`) becomes a MUTABLE field cell.
        const refs = memberNodes.map((vm) => vm.kids.some((k) => k.name === "REF"));
        this.setVariant(name, { id: this.nextVariantId++, fields, refs, methods, ownVariants, order: this.curOrder });
      } else {
        const nm = this.childNamed(kid, "NAME");
        if (nm) this.setVariant(nm.value!, { id: this.nextVariantId++, fields: [], methods, ownVariants, order: this.curOrder });
      }
    }
    if (typeName && this.nextVariantId > minId) {
      this.dataTypeRanges.set(typeName, { min: minId, max: this.nextVariantId - 1 });
    }
  }

  // Register a variant by name: `variants` keeps the last-wins entry (used by the
  // existing arity-based dispatch); `variantGens` keeps EVERY generation with its
  // defining module, for module-aware `N.member` and cross-module shadowing.
  private setVariant(name: string, info: VariantInfo) {
    this.variants.set(name, info);
    const gens = this.variantGens.get(name) ?? [];
    gens.push({ info, mod: this.curMod });
    this.variantGens.set(name, gens);
  }

  // The variant for `name` defined by MODULE `mod` (module-aware `N.member`).
  private variantForMod(name: string, mod: number): VariantInfo | undefined {
    return this.variantGens.get(name)?.find((g) => g.mod === mod)?.info;
  }

  // The module a `N.member` access targets: importer = the module of the top-level
  // item currently compiling (orderToMod[resolveOrder]); look its alias up. Undefined
  // when unknown -> caller falls back to legacy first/last-wins resolution.
  private moduleTargetFor(alias: string | null): number | undefined {
    if (alias === null) return undefined;
    const importer = this.orderToMod.get(this.resolveOrder);
    if (importer === undefined) return undefined;
    return this.aliasMap.get(importer)?.get(alias);
  }

  // Method fields (`method m(self, ...): ... end`) inside a with:/sharing:/obj block.
  private collectMethods(container: CstNode | undefined): { name: string; node: CstNode }[] {
    const fieldsNode = container && this.childNamed(container, "fields");
    if (!fieldsNode) return [];
    return fieldsNode.kids
      .filter((k) => k.name === "field" && k.kids.some((c) => c.name === "METHOD"))
      .map((f) => {
        const key = this.childNamed(f, "key");
        const name = key ? this.childNamed(key, "NAME")!.value! : this.childNamed(f, "NAME")!.value!;
        return { name, node: f };
      });
  }

  // Populate $variant_methods[id] with a methods object for each variant that has
  // with:/sharing: methods (emitted into $main's body).
  private initVariantMethods(ctx: Ctx, body: number[]) {
    const m = this.m;
    const withMethods = [...this.variants.values()].filter((v) => v.methods && v.methods.length > 0);
    if (withMethods.length === 0) return;
    const nulls = Array.from({ length: this.nextVariantId }, () => m.ref.null(binaryen.anyref));
    body.push(m.global.set("$variant_methods", m.array.new_fixed(this.t.Fields, nulls)));
    const reg = () => m.ref.cast(m.global.get("$variant_methods", this.t.FieldsRefNull), this.t.FieldsRef);
    for (const v of withMethods) {
      // Method bodies resolve names as of their data decl's position (e.g. List's
      // `.map` body `map(f, self)` binds to the prelude `map`, not a later `shadow`).
      this.resolveOrder = v.order ?? Infinity;
      body.push(m.array.set(reg(), m.i32.const(v.id), this.makeMethodsObject(v.methods!, ctx, v.ownVariants)));
    }
    this.resolveOrder = Infinity;
  }
  // Populate $variant_names[id] with the variant's field-name list ($Names array),
  // for every variant that has fields (emitted into $main's body).
  private initVariantNames(ctx: Ctx, body: number[]) {
    const m = this.m;
    const withFields = [...this.variants.values()].filter((v) => v.fields.length > 0);
    if (withFields.length === 0) return;
    const nulls = Array.from({ length: this.nextVariantId }, () => m.ref.null(binaryen.anyref));
    body.push(m.global.set("$variant_names", m.array.new_fixed(this.t.Fields, nulls)));
    const reg = () => m.ref.cast(m.global.get("$variant_names", this.t.FieldsRefNull), this.t.FieldsRef);
    for (const v of withFields) {
      const names = v.fields.map((f) => this.strLiteralRaw(f));
      body.push(m.array.set(reg(), m.i32.const(v.id), m.array.new_fixed(this.t.Names, names)));
    }
  }
  // An $Object holding a variant's methods (name -> $Method closure), self-bound.
  private makeMethodsObject(methods: { name: string; node: CstNode }[], ctx: Ctx, ownVariants?: string[]): number {
    const m = this.m;
    const names = methods.map((meth) => this.strLiteralRaw(meth.name));
    const savedScope = this.methodVariantScope;
    this.methodVariantScope = ownVariants ? new Set(ownVariants) : savedScope;
    const values = methods.map((meth) => {
      const closure = this.buildClosureFromParts(this.headerParamBindings(meth.node), this.childNamed(meth.node, "block")!, ctx, "$vmth_");
      return m.struct.new([m.ref.cast(closure, this.t.ClosureRef)], this.t.Method);
    });
    this.methodVariantScope = savedScope;
    return m.call("$make_object", [m.array.new_fixed(this.t.Names, names), m.array.new_fixed(this.t.Fields, values)], this.t.ObjectRef);
  }

  private strLiteralRaw(s: string): number {
    const bytes = new TextEncoder().encode(s);
    return this.m.array.new_fixed(this.t.Str, Array.from(bytes, (b) => this.m.i32.const(b)));
  }

  private makeVariant(name: string, info: VariantInfo, args: number[]): number {
    const m = this.m;
    // ref-annotated fields are stored as mutable 1-cell boxes (so obj!f / obj!{f:v}
    // can read/write them in place); non-ref fields store the value directly.
    const stored = info.refs ? args.map((a, i) => (info.refs![i] ? this.makeBox(a) : a)) : args;
    const fields = stored.length === 0
      ? m.ref.null(this.t.FieldsRefNull)
      : m.array.new_fixed(this.t.Fields, stored);
    return m.call("$make_variant", [m.i32.const(info.id), this.strLiteralRaw(name), fields], this.t.VariantRef);
  }

  // ---- functions / closures ----
  private bindingName(binding: CstNode): string {
    let n = binding;
    while (n && (n.name === "toplevel-binding" || n.name === "binding" || n.name === "name-binding")) {
      const nm = this.childNamed(n, "NAME");
      if (nm) return nm.value!;
      n = n.kids[0]!;
    }
    throw new CompileError("could not extract binding name", binding);
  }

  // Tuple-binding `{a; b; ...}` -> its component binding nodes, else null.
  private tupleComponents(binding: CstNode): CstNode[] | null {
    let n: CstNode | undefined = binding;
    while (n && (n.name === "toplevel-binding" || n.name === "binding")) {
      const tb = this.childNamed(n, "tuple-binding");
      if (tb) return tb.kids.filter((k) => k.name === "binding");
      if (this.childNamed(n, "name-binding")) break;
      n = n.kids[0];
    }
    return null;
  }

  // The `as NAME` alias on a tuple-binding `{a; b} as name` (binds the whole tuple),
  // or null. The AS + name-binding sit inside the tuple-binding node after the `}`.
  private tupleAsName(binding: CstNode): string | null {
    let n: CstNode | undefined = binding;
    while (n && (n.name === "toplevel-binding" || n.name === "binding")) {
      const tb = this.childNamed(n, "tuple-binding");
      if (tb) {
        const asIdx = tb.kids.findIndex((k) => k.name === "AS");
        if (asIdx >= 0) {
          const nb = tb.kids.slice(asIdx).find((k) => k.name === "name-binding");
          if (nb) { const nm = this.childNamed(nb, "NAME"); if (nm) return nm.value!; }
        }
        return null;
      }
      if (this.childNamed(n, "name-binding")) break;
      n = n.kids[0];
    }
    return null;
  }

  // All names introduced by a binding (recursively flattening tuple bindings; a
  // `{a; b} as whole` binds the components AND `whole`).
  private bindingNames(binding: CstNode): string[] {
    const comps = this.tupleComponents(binding);
    if (comps) {
      const names = comps.flatMap((c) => this.bindingNames(c));
      const asN = this.tupleAsName(binding);
      return asN ? [...names, asN] : names;
    }
    return [this.bindingName(binding)];
  }

  // Like bindingNames, but EXCLUDES `shadow` names. A `shadow x = e` binding's name
  // must NOT be in scope within its own RHS `e` (which refers to the OUTER x), so for
  // free-variable/capture analysis we don't pre-bind shadowed names — otherwise a
  // closure doing `shadow x = x.foo()` fails to capture the outer x. (Pervasive in the
  // real compiler's accumulator pattern.)
  private hasShadowToken(node: CstNode): boolean {
    if (node.name === "SHADOW") return true;
    return node.kids.some((k) => this.hasShadowToken(k));
  }
  private nonShadowBindingNames(binding: CstNode): string[] {
    const comps = this.tupleComponents(binding);
    if (comps) {
      const names = comps.flatMap((c) => this.nonShadowBindingNames(c));
      const asN = this.tupleAsName(binding);
      return asN ? [...names, asN] : names;
    }
    return this.hasShadowToken(binding) ? [] : [this.bindingName(binding)];
  }

  // Bind `value` to `binding` (a name, or a tuple-destructure) as local(s), appending
  // the resulting local.set statements to `parts`. Tuple: store in a temp, then bind
  // each component to `temp.{i}` via $variant_field (tuples are variant id 0).
  private emitBinding(binding: CstNode, value: number, ctx: Ctx, parts: number[]): void {
    const m = this.m;
    const comps = this.tupleComponents(binding);
    if (comps) {
      const tmp = ctx.addLocal(binaryen.anyref);
      parts.push(m.local.set(tmp, value));
      const whole = () => m.local.get(tmp, binaryen.anyref);
      // `{a; b} as name` also binds the whole tuple value to `name`.
      const asName = this.tupleAsName(binding);
      if (asName) {
        const idx = ctx.addLocal(binaryen.anyref);
        ctx.locals.set(asName, idx);
        parts.push(m.local.set(idx, ctx.boxed.has(asName) ? this.makeBox(whole()) : whole()));
      }
      comps.forEach((c, i) => {
        const field = m.call("$variant_field",
          [m.ref.cast(whole(), this.t.VariantRef), m.i32.const(i)], binaryen.anyref);
        this.emitBinding(c, field, ctx, parts);
      });
    } else {
      const name = this.bindingName(binding);
      const idx = ctx.addLocal(binaryen.anyref);
      ctx.locals.set(name, idx);
      parts.push(m.local.set(idx, ctx.boxed.has(name) ? this.makeBox(value) : value));
    }
  }

  // The binding nodes for a function/lambda header — one per arg SLOT (a slot may
  // be a tuple-binding `{a; b}`, which binds multiple names from one argument).
  private headerParamBindings(fnLike: CstNode): CstNode[] {
    const header = this.childNamed(fnLike, "fun-header");
    const args = header && this.childNamed(header, "args");
    if (!args) return [];
    return args.kids.filter((k) => k.name === "binding");
  }

  // All names a header binds (flattening tuple-binding params).
  private headerParams(fnLike: CstNode): string[] {
    return this.headerParamBindings(fnLike).flatMap((b) => this.bindingNames(b));
  }

  // Compile a fun-expr or lambda-expr into a wasm function with the uniform
  // calling convention. `captures` maps captured free-var names -> caps index.
  private compileFunction(wasmName: string, fnLike: CstNode, captures: Map<string, number>) {
    this.compileFunctionParts(wasmName, this.headerParamBindings(fnLike), this.childNamed(fnLike, "block")!, captures);
  }

  private compileFunctionParts(wasmName: string, paramBindings: CstNode[], bodyBlock: CstNode, captures: Map<string, number>, inheritedBoxed?: Set<string>) {
    const m = this.m;
    const ctx = new Ctx(false);
    const allParamNames = paramBindings.flatMap((b) => this.bindingNames(b));
    captures.forEach((idx, name) => ctx.captures.set(name, idx));
    // boxed = vars declared here that nested closures capture, plus boxed vars
    // we inherited as captures (the cell is shared down the closure chain).
    // A param can shadow an outer (inherited) boxed var — that param is NOT boxed.
    // But a local `var` may itself shadow a param (`var shadow n = n`) and be
    // captured; that var MUST stay boxed — so add local var boxing AFTER the
    // param-delete (the param read before the var decl resolves to the param slot,
    // which is never unboxed; references after the var decl hit the boxed local).
    if (inheritedBoxed) inheritedBoxed.forEach((n) => ctx.boxed.add(n));
    allParamNames.forEach((p) => ctx.boxed.delete(p));
    this.boxedVarsFor(bodyBlock).forEach((n) => ctx.boxed.add(n));
    // Each binding occupies one arg slot. Simple names map directly to the slot;
    // a tuple-binding param destructures its slot value into locals at entry.
    const prelude: number[] = [];
    paramBindings.forEach((b, i) => {
      if (this.tupleComponents(b) === null) {
        ctx.params.set(this.bindingName(b), i);
      } else {
        const argVal = m.array.get(m.local.get(1, this.t.FieldsRefNull), m.i32.const(i), binaryen.anyref, false);
        this.emitBinding(b, argVal, ctx, prelude);
      }
    });
    const body = this.compileBlock(bodyBlock, ctx, true);
    const full = prelude.length ? m.block(null, [...prelude, body], binaryen.anyref) : body;
    m.addFunction(wasmName, this.sig, binaryen.anyref, ctx.localTypes, full);
  }

  // Build a $Closure value from explicit param bindings + a body block, computing
  // captures against the enclosing ctx. Used by lambdas, local funs, methods, for.
  private buildClosureFromParts(paramBindings: CstNode[], bodyBlock: CstNode, ctx: Ctx, prefix: string): number {
    const allParamNames = paramBindings.flatMap((b) => this.bindingNames(b));
    const free = this.freeVars(bodyBlock, new Set(allParamNames));
    const caps: string[] = [];
    for (const name of free) {
      if (ctx.locals.has(name) || ctx.params.has(name) || ctx.captures.has(name)) caps.push(name);
    }
    const capMap = new Map<string, number>();
    caps.forEach((n, i) => capMap.set(n, i));
    const fnIndex = this.fnNames.length;
    const wasmName = prefix + fnIndex;
    this.fnNames.push(wasmName);
    const inheritedBoxed = new Set(caps.filter((n) => ctx.boxed.has(n)));
    this.compileFunctionParts(wasmName, paramBindings, bodyBlock, capMap, inheritedBoxed);
    return this.makeClosure(fnIndex, caps, ctx);
  }

  // Build a 0-arg thunk closure whose body is an arbitrary expression.
  private buildThunkFromExpr(exprNode: CstNode, ctx: Ctx, prefix: string): number {
    const free = this.freeVars(exprNode, new Set());
    const caps: string[] = [];
    for (const n of free) if (ctx.locals.has(n) || ctx.params.has(n) || ctx.captures.has(n)) caps.push(n);
    const fnIndex = this.fnNames.length;
    const wasmName = prefix + fnIndex;
    this.fnNames.push(wasmName);
    const fctx = new Ctx(false);
    caps.forEach((n, i) => fctx.captures.set(n, i));
    caps.forEach((n) => { if (ctx.boxed.has(n)) fctx.boxed.add(n); });
    this.boxedVarsFor(exprNode).forEach((n) => fctx.boxed.add(n));
    const body = this.compileExpr(exprNode, fctx, true);
    this.m.addFunction(wasmName, this.sig, binaryen.anyref, fctx.localTypes, body);
    return this.makeClosure(fnIndex, caps, ctx);
  }

  // Build a $Closure value. captureNames are resolved in the enclosing ctx.
  private makeClosure(fnIndex: number, captureNames: string[], enclosing: Ctx): number {
    const m = this.m;
    const caps = captureNames.length === 0
      ? m.ref.null(this.t.FieldsRefNull)
      // boxed names are captured as the box CELL (raw), so the cell is shared.
      : m.array.new_fixed(this.t.Fields, captureNames.map((n) => this.resolveName(n, enclosing, enclosing.boxed.has(n))!));
    return m.struct.new([m.i32.const(fnIndex), caps], this.t.Closure);
  }

  // Reify a data constructor as a first-class function (uniform calling convention:
  // reads its args from the args array and builds the variant). Generated once.
  private constructorFnIndex(name: string, info: VariantInfo): number {
    if (this.ctorFns.has(name)) return this.ctorFns.get(name)!;
    const m = this.m;
    const fnIndex = this.fnNames.length;
    const wasmName = "$ctor_" + fnIndex + "_" + name;
    this.fnNames.push(wasmName);
    const argAt = (i: number) => m.array.get(m.local.get(1, this.t.FieldsRefNull), m.i32.const(i), binaryen.anyref, false);
    const body = this.makeVariant(name, info, info.fields.map((_, i) => argAt(i)));
    m.addFunction(wasmName, this.sig, binaryen.anyref, [], body);
    this.ctorFns.set(name, fnIndex);
    return fnIndex;
  }
  // Reify an is-<variant> predicate as a first-class function.
  private predicateFnIndex(vname: string): number {
    if (this.predFns.has(vname)) return this.predFns.get(vname)!;
    const m = this.m;
    const v = this.variants.get(vname)!;
    const fnIndex = this.fnNames.length;
    const wasmName = "$is_" + fnIndex + "_" + vname;
    this.fnNames.push(wasmName);
    const arg = () => m.array.get(m.local.get(1, this.t.FieldsRefNull), m.i32.const(0), binaryen.anyref, false);
    const body = this.mkBool(m.if(m.ref.test(arg(), this.t.VariantRefNull),
      m.i32.eq(m.call("$variant_id", [m.ref.cast(arg(), this.t.VariantRef)], binaryen.i32), m.i32.const(v.id)),
      m.i32.const(0), binaryen.i32));
    m.addFunction(wasmName, this.sig, binaryen.anyref, [], body);
    this.predFns.set(vname, fnIndex);
    return fnIndex;
  }

  // Reify the data-TYPE predicate `is-<TypeName>` (true for any variant of that
  // data type) as a first-class function: value is a $Variant whose id is in range.
  private typePredicateFnIndex(typeName: string): number {
    if (this.typePredFns.has(typeName)) return this.typePredFns.get(typeName)!;
    const m = this.m;
    const r = this.dataTypeRanges.get(typeName)!;
    const fnIndex = this.fnNames.length;
    const wasmName = "$isty_" + fnIndex + "_" + typeName;
    this.fnNames.push(wasmName);
    const arg = () => m.array.get(m.local.get(1, this.t.FieldsRefNull), m.i32.const(0), binaryen.anyref, false);
    const idv = () => m.call("$variant_id", [m.ref.cast(arg(), this.t.VariantRef)], binaryen.i32);
    const body = this.mkBool(m.if(m.ref.test(arg(), this.t.VariantRefNull),
      m.i32.and(m.i32.ge_s(idv(), m.i32.const(r.min)), m.i32.le_s(idv(), m.i32.const(r.max))),
      m.i32.const(0), binaryen.i32));
    m.addFunction(wasmName, this.sig, binaryen.anyref, [], body);
    this.typePredFns.set(typeName, fnIndex);
    return fnIndex;
  }

  // Resolve an identifier to a binaryen expression, or null if unbound.
  // raw=true returns a boxed var's CELL (for capture/assign) instead of its value.
  private resolveName(name: string, ctx: Ctx, raw = false): number | null {
    const m = this.m;
    if (name === "nothing") return m.ref.i31(m.i32.const(2));
    if (ctx.locals.has(name)) {
      const cell = m.local.get(ctx.locals.get(name)!, binaryen.anyref);
      return (ctx.boxed.has(name) && !raw) ? this.unbox(cell) : cell;
    }
    if (ctx.params.has(name)) {
      return m.array.get(m.local.get(1, this.t.FieldsRefNull), m.i32.const(ctx.params.get(name)!), binaryen.anyref, false);
    }
    if (ctx.captures.has(name)) {
      const caps = m.struct.get(1, m.local.get(0, this.t.ClosureRef), this.t.FieldsRefNull, false);
      const cell = m.array.get(caps, m.i32.const(ctx.captures.get(name)!), binaryen.anyref, false);
      return (ctx.boxed.has(name) && !raw) ? this.unbox(cell) : cell;
    }
    // Inside a data type's methods, its own variant wins over a top-level `shadow`.
    if (this.methodVariantScope?.has(name) && this.variants.has(name)) {
      const vv = this.variants.get(name)!;
      return vv.fields.length === 0 ? this.makeVariant(name, vv, []) : this.makeClosure(this.constructorFnIndex(name, vv), [], ctx);
    }
    if (this.topScope.has(name)) return m.global.get(this.globalFor(name)!, binaryen.anyref);
    const v = this.variants.get(name);
    if (v) {
      // nullary variant -> the singleton value; with fields -> a constructor function.
      if (v.fields.length === 0) return this.makeVariant(name, v, []);
      return this.makeClosure(this.constructorFnIndex(name, v), [], ctx);
    }
    // bare `is-<variant>` -> a first-class predicate function.
    if (name.startsWith("is-") && this.variants.has(name.slice(3))) {
      return this.makeClosure(this.predicateFnIndex(name.slice(3)), [], ctx);
    }
    // bare `is-<TypeName>` -> the data-type predicate (any variant of that type).
    if (name.startsWith("is-") && this.dataTypeRanges.has(name.slice(3))) {
      return this.makeClosure(this.typePredicateFnIndex(name.slice(3)), [], ctx);
    }
    // bare reference to a unary string-rendering builtin -> a first-class function.
    if (name === "tostring" || name === "to-string" || name === "torepr" || name === "to-repr") {
      return this.makeClosure(this.tostringFnIndex(name), [], ctx);
    }
    return null;
  }
  // Reify tostring/torepr as a first-class function (they all route to $tostring).
  private tostringFnIndex(name: string): number {
    if (this.tostringFns.has(name)) return this.tostringFns.get(name)!;
    const m = this.m;
    const fnIndex = this.fnNames.length;
    const wasmName = "$intr_" + fnIndex + "_" + name;
    this.fnNames.push(wasmName);
    const arg = m.array.get(m.local.get(1, this.t.FieldsRefNull), m.i32.const(0), binaryen.anyref, false);
    m.addFunction(wasmName, this.sig, binaryen.anyref, [], m.call("$tostring", [arg], this.t.StrRef));
    this.tostringFns.set(name, fnIndex);
    return fnIndex;
  }
  // A boxed (captured-and-mutated) var lives in a 1-element $Fields array, shared
  // by reference so a closure's assignment is visible to the enclosing scope.
  private unbox(cell: number): number {
    return this.m.array.get(this.m.ref.cast(cell, this.t.FieldsRef), this.m.i32.const(0), binaryen.anyref, false);
  }
  private makeBox(value: number): number {
    return this.m.array.new_fixed(this.t.Fields, [value]);
  }
  private setBox(cell: number, value: number): number {
    return this.m.array.set(this.m.ref.cast(cell, this.t.FieldsRef), this.m.i32.const(0), value);
  }

  // $variant_names entry (a Names array) for a variant value's runtime variant id.
  private variantNamesOf(vget: number): number {
    const m = this.m;
    return m.ref.cast(
      m.array.get(m.ref.cast(m.global.get("$variant_names", this.t.FieldsRefNull), this.t.FieldsRef),
        m.call("$variant_id", [vget], binaryen.i32), binaryen.anyref, false),
      this.t.NamesRef);
  }

  // `obj!field` (get-bang) — read a mutable `ref` field, stored as a 1-cell box, by name.
  private compileGetBang(node: CstNode, ctx: Ctx): number {
    const m = this.m;
    const objExpr = node.kids[0]!;
    const fieldName = node.kids[node.kids.length - 1]!.value!;
    const tmp = ctx.addLocal(binaryen.anyref);
    const vget = () => m.ref.cast(m.local.get(tmp, binaryen.anyref), this.t.VariantRef);
    const cell = m.call("$variant_field_by_name",
      [vget(), this.variantNamesOf(vget()), this.strLiteralRaw(fieldName)], binaryen.anyref);
    return m.block(null, [m.local.set(tmp, this.compileExpr(objExpr, ctx, false)), this.unbox(cell)], binaryen.anyref);
  }

  // `obj!{f: v, ...}` (set-bang) — write mutable ref field cell(s) in place; returns the object.
  private compileUpdate(node: CstNode, ctx: Ctx): number {
    const m = this.m;
    const objExpr = node.kids[0]!;
    const fieldsNode = this.childNamed(node, "fields")!;
    const entries = fieldsNode.kids.filter((k) => k.name === "field");
    const tmp = ctx.addLocal(binaryen.anyref);
    const vget = () => m.ref.cast(m.local.get(tmp, binaryen.anyref), this.t.VariantRef);
    const parts: number[] = [m.local.set(tmp, this.compileExpr(objExpr, ctx, false))];
    for (const f of entries) {
      const key = this.childNamed(this.childNamed(f, "key")!, "NAME")!.value!;
      const valNode = f.kids[f.kids.length - 1]!;
      const cell = m.call("$variant_field_by_name",
        [vget(), this.variantNamesOf(vget()), this.strLiteralRaw(key)], binaryen.anyref);
      parts.push(this.setBox(cell, this.compileExpr(valNode, ctx, false)));
    }
    parts.push(m.local.get(tmp, binaryen.anyref));
    return m.block(null, parts, binaryen.anyref);
  }

  // ---- free variable analysis ----
  // A `method m(self, ...): ... end` field inside an obj-expr / extend-expr / data
  // with:/sharing: block. Its body is a closure (params incl. self are bound).
  private isMethodField(node: CstNode): boolean {
    return (node.name === "obj-field" || node.name === "field")
      && node.kids.some((c) => c.name === "METHOD");
  }

  private freeVars(node: CstNode, bound: Set<string>): Set<string> {
    const out = new Set<string>();
    const add = (s: Set<string>) => s.forEach((x) => out.add(x));
    if (this.isMethodField(node)) {
      // bind the method's params (incl. self) so they aren't spuriously captured.
      const b2 = new Set(bound);
      for (const p of this.headerParams(node)) b2.add(p);
      const body = this.childNamed(node, "block");
      if (body) add(this.freeVars(body, b2));
      return out;
    }
    if (node.name === "id-expr") {
      const nm = this.only(node).value!;
      if (!bound.has(nm)) out.add(nm);
      return out;
    }
    // `name := rhs`: the assigned name is a USE (LHS is a bare NAME, not an id-expr),
    // so a closure that only assigns a var still captures it (and must box it).
    if (node.name === "assign-expr") {
      const nm = node.kids[0]!.value!;
      if (nm && !bound.has(nm)) out.add(nm);
      for (const k of node.kids) add(this.freeVars(k, bound));
      return out;
    }
    if (node.name === "lambda-expr" || node.name === "fun-expr") {
      const b2 = new Set(bound);
      if (node.name === "fun-expr") { const nm = this.childNamed(node, "NAME"); if (nm) b2.add(nm.value!); }
      for (const p of this.headerParams(node)) b2.add(p);
      const body = this.childNamed(node, "block");
      if (body) add(this.freeVars(body, b2));
      return out;
    }
    if (node.name === "block") {
      const b2 = new Set(bound);
      for (const stmt of node.kids.filter((k) => k.name === "stmt")) {
        const inner = this.only(stmt);
        // let/var/rec all introduce block-scoped bindings; omitting var here made a
        // `var n` look free, spuriously propagating it upward as a captured var.
        // nonShadowBindingNames: a `shadow x = <expr using x>` must NOT pre-bind x, so
        // its RHS still captures the outer x.
        if (inner.name === "let-expr" || inner.name === "var-expr" || inner.name === "rec-expr")
          for (const nm of this.nonShadowBindingNames(this.letBinding(inner))) b2.add(nm);
        else if (inner.name === "fun-expr") { const nm = this.childNamed(inner, "NAME"); if (nm) b2.add(nm.value!); }
      }
      for (const k of node.kids) add(this.freeVars(k, b2));
      return out;
    }
    if (node.name === "cases-branch") {
      const b2 = new Set(bound);
      const argsNode = this.childNamed(node, "cases-args");
      if (argsNode) for (const cb of argsNode.kids.filter((k) => k.name === "cases-binding")) {
        for (const nm of this.bindingNames(this.childNamed(cb, "binding") ?? cb)) b2.add(nm);
      }
      for (const k of node.kids) add(this.freeVars(k, b2));
      return out;
    }
    if (node.name === "multi-let-expr" || node.name === "letrec-expr") {
      const b2 = new Set(bound);
      for (const b of this.multiLetBinds(node)) for (const nm of this.nonShadowBindingNames(this.letBinding(b))) b2.add(nm);
      for (const k of node.kids) add(this.freeVars(k, b2));
      return out;
    }
    if (node.name === "type-let-expr") {
      const body = this.childNamed(node, "block");
      if (body) add(this.freeVars(body, bound)); // type binds erased
      return out;
    }
    if (node.name === "for-expr") {
      // for ITER(x from e1, y from e2 ...): body end -- x,y bound in the body;
      // e1,e2 and ITER are evaluated in the enclosing scope. (The body becomes a
      // lambda at compile time, so its loop vars are NOT visible outside.)
      const b2 = new Set(bound);
      for (const fb of node.kids.filter((k) => k.name === "for-bind")) {
        const fe = fb.kids.find((k) => k.name === "binop-expr");
        if (fe) add(this.freeVars(fe, bound));
        const b = this.childNamed(fb, "binding");
        if (b) for (const nm of this.bindingNames(b)) b2.add(nm);
      }
      const iter = node.kids.find((k) => k.name === "expr");
      if (iter) add(this.freeVars(iter, bound));
      const body = this.childNamed(node, "block");
      if (body) add(this.freeVars(body, b2));
      return out;
    }
    for (const k of node.kids) add(this.freeVars(k, bound));
    return out;
  }

  // The loop-variable names bound by a `for` expression's for-binds.
  private forBindVars(node: CstNode): Set<string> {
    const params = new Set<string>();
    for (const fb of node.kids.filter((k) => k.name === "for-bind")) {
      const b = this.childNamed(fb, "binding");
      if (b) for (const nm of this.bindingNames(b)) params.add(nm);
    }
    return params;
  }

  // ---- mutable-variable capture (boxing) ----
  // A function-local `var` that is captured by a nested closure must live in a
  // shared mutable cell (a 1-element $Fields array): the closure captures the cell
  // by reference, so assignments are visible across the closure boundary. (Top-level
  // vars are globals — already shared — so only function-local vars need boxing.)

  // Names declared via `var` within `node`, NOT descending into nested closures.
  private varDeclsIn(node: CstNode, out: Set<string>): void {
    if (node.name === "lambda-expr" || node.name === "fun-expr") return; // separate scope
    if (node.name === "for-expr") {
      // the for body is a separate (closure) scope; only the iter/source exprs are here.
      for (const fb of node.kids.filter((k) => k.name === "for-bind")) {
        const fe = fb.kids.find((k) => k.name === "binop-expr");
        if (fe) this.varDeclsIn(fe, out);
      }
      const iter = node.kids.find((k) => k.name === "expr");
      if (iter) this.varDeclsIn(iter, out);
      return;
    }
    if (node.name === "var-expr") for (const nm of this.bindingNames(this.letBinding(node))) out.add(nm);
    for (const k of node.kids) this.varDeclsIn(k, out);
  }
  // Free variables referenced inside ANY closure nested in `node` (i.e. names a
  // nested lambda/fun — or a `for` body, which becomes a lambda — would capture).
  private freeInNestedClosures(node: CstNode, out: Set<string>): void {
    if (node.name === "lambda-expr" || node.name === "fun-expr") {
      this.freeVars(node, new Set()).forEach((n) => out.add(n));
      // still descend so we also see closures nested inside this one
    } else if (this.isMethodField(node)) {
      // a method body is a closure too — a `var` it captures+assigns must be boxed.
      const body = this.childNamed(node, "block");
      if (body) this.freeVars(body, new Set(this.headerParams(node))).forEach((n) => out.add(n));
    }
    if (node.name === "for-expr") {
      // for body compiles to a lambda -> it captures its free vars (minus loop vars).
      const body = this.childNamed(node, "block");
      if (body) this.freeVars(body, this.forBindVars(node)).forEach((n) => out.add(n));
    }
    for (const k of node.kids) this.freeInNestedClosures(k, out);
  }
  // var names declared in this body that some nested closure captures -> must box.
  private boxedVarsFor(bodyBlock: CstNode): Set<string> {
    const decls = new Set<string>();
    this.varDeclsIn(bodyBlock, decls);
    if (decls.size === 0) return new Set();
    const captured = new Set<string>();
    this.freeInNestedClosures(bodyBlock, captured);
    return new Set([...decls].filter((n) => captured.has(n)));
  }

  // capture set = free vars that resolve to an enclosing local/param/capture
  // (top-level globals and variants are reachable directly, so not captured).
  // ---- expressions ----
  private compileExpr(node: CstNode, ctx: Ctx, tail: boolean): number {
    const m = this.m;
    switch (node.name) {
      case "check-test":
      case "expr":
      case "prim-expr":
        return this.compileExpr(this.only(node), ctx, tail);
      case "binop-expr":
        if (node.kids.length === 1) return this.compileExpr(node.kids[0]!, ctx, tail);
        return this.compileBinopExpr(node, ctx);
      case "paren-expr": {
        const inner = this.childNamed(node, "binop-expr");
        if (!inner) throw new CompileError("empty paren-expr", node);
        return this.compileExpr(inner, ctx, tail);
      }
      case "app-expr":
        return this.compileApp(node, ctx, tail);
      case "lambda-expr":
        return this.compileLambda(node, ctx);
      case "method-expr": {
        // A standalone first-class method value: `method(self, ...): body end`.
        // Same representation as an object/variant method field — a $Method wrapping
        // a closure whose first param is `self` — so it round-trips with dispatch.
        const closure = this.buildClosureFromParts(this.headerParamBindings(node), this.childNamed(node, "block")!, ctx, "$mthx_");
        return m.struct.new([m.ref.cast(closure, this.t.ClosureRef)], this.t.Method);
      }
      case "id-expr": {
        const name = this.only(node).value!;
        const r = this.resolveName(name, ctx);
        if (r === null) throw new CompileError(`unbound identifier: ${name}`, node);
        return r;
      }
      case "cases-expr":
        return this.compileCases(node, ctx, tail);
      case "num-expr":
        return this.compileNumber(this.only(node).value!);
      case "frac-expr":
        return this.compileRational(this.only(node).value!, false);
      case "rfrac-expr":
        return this.compileRational(this.only(node).value!, true);
      case "bool-expr":
        return m.ref.i31(m.i32.const(this.only(node).name === "TRUE" ? 1 : 0));
      case "string-expr":
        return this.compileString(this.only(node).value!);
      case "if-expr":
        return this.compileIf(node, ctx, tail);
      case "if-pipe-expr":
        return this.compileIfPipe(node, ctx, tail);
      case "construct-expr":
        return this.compileConstruct(node, ctx);
      case "obj-expr":
        return this.compileObject(node, ctx);
      case "method-expr": {
        // anonymous `method(self, ...): ... end` -> a first-class $Method value
        // (self-binding method closure; same representation as object method fields).
        const closure = this.buildClosureFromParts(
          this.headerParamBindings(node), this.childNamed(node, "block")!, ctx, "$amth_");
        return this.m.struct.new([this.m.ref.cast(closure, this.t.ClosureRef)], this.t.Method);
      }
      case "dot-expr":
        return this.compileDot(node, ctx);
      case "get-bang-expr":
        return this.compileGetBang(node, ctx);
      case "update-expr":
        return this.compileUpdate(node, ctx);
      case "extend-expr":
        return this.compileExtend(node, ctx);
      case "for-expr":
        return this.compileFor(node, ctx, tail);
      case "user-block-expr": {
        const blk = this.childNamed(node, "block")!;
        return this.compileBlock(blk, ctx, tail);
      }
      case "inst-expr":
        // generic instantiation `expr<T, ...>` — type args erased
        return this.compileExpr(node.kids[0]!, ctx, tail);
      case "template-expr":
        // `...` placeholder — Pyret compiles it; running it raises "unfinished".
        return this.compileIntrinsic("raise",
          [this.compileString("template-not-finished: this expression is unfinished (...)")], ctx)!;
      case "tuple-expr": {
        // {e1; e2; ...} — a positional tuple (reserved variant id 0)
        const fields = this.childNamed(node, "tuple-fields")!;
        const elems = fields.kids.filter((k) => k.name === "binop-expr").map((e) => this.compileExpr(e, ctx, false));
        const arr = elems.length === 0
          ? m.ref.null(this.t.FieldsRefNull)
          : m.array.new_fixed(this.t.Fields, elems);
        return m.call("$make_variant", [m.i32.const(0), this.strLiteralRaw("tuple"), arr], this.t.VariantRef);
      }
      case "tuple-get": {
        // expr.{N}
        const idx = parseInt(this.childNamed(node, "NUMBER")!.value!, 10);
        const tup = m.ref.cast(this.compileExpr(node.kids[0]!, ctx, false), this.t.VariantRef);
        return m.call("$variant_field", [tup, m.i32.const(idx)], binaryen.anyref);
      }
      case "assign-expr": {
        // NAME := binop-expr  (mutation; returns nothing)
        const nm = node.kids[0]!.value!;
        const value = this.compileExpr(node.kids[node.kids.length - 1]!, ctx, false);
        let setter: number;
        if (ctx.boxed.has(nm)) setter = this.setBox(this.resolveName(nm, ctx, /*raw*/ true)!, value);
        else if (ctx.locals.has(nm)) setter = m.local.set(ctx.locals.get(nm)!, value);
        else if (this.topScope.has(nm)) setter = m.global.set(this.globalFor(nm)!, value);
        else throw new CompileError(`cannot assign to unbound or non-var identifier: ${nm}`, node);
        return m.block(null, [setter, m.ref.i31(m.i32.const(2))], binaryen.anyref);
      }
      case "multi-let-expr":
      case "letrec-expr":
        // `let a = e1, b = e2 (block|:) body end` (and letrec). Desugar to a block:
        // the bindings become block-local let/var statements scoping the body.
        return this.compileMultiLet(node, ctx, tail);
      case "type-let-expr": {
        // `type-let T = ... : body end` — type binds erased (no type-checker).
        const body = this.childNamed(node, "block")!;
        return this.compileBlock(body, ctx, tail);
      }
      default:
        throw new CompileError(`unsupported expression: ${node.name}`, node);
    }
  }

  // [list: e1, e2, ...] -> link(e1, link(e2, ... empty))
  private compileConstruct(node: CstNode, ctx: Ctx): number {
    const m = this.m;
    const ctorNode = node.kids.find((k) => k.name === "binop-expr")!;
    // The ctor may be a bare name (`[list: ..]`) or module-qualified (`[SD.string-dict: ..]`,
    // common in the real front-end). For the built-in collections, the member name alone
    // selects the desugaring (list/string-dict/set/...), so look through a module alias.
    const ctorDot = this.asDot(ctorNode);
    const ctorName = (ctorDot && this.moduleAliasName(ctorDot.objExpr)) ? ctorDot.name : this.simpleName(ctorNode);
    const trailing = this.childNamed(node, "trailing-opt-comma-binops");
    const cb = trailing && this.childNamed(trailing, "comma-binops");
    const elems = cb ? cb.kids.filter((k) => k.name === "binop-expr") : [];
    // [list: ...] desugars directly to link/empty (handles any length efficiently).
    if (ctorName === "list") {
      const emptyInfo = this.variants.get("empty");
      const linkInfo = this.variants.get("link");
      if (!emptyInfo || !linkInfo) throw new CompileError("List type unavailable (prelude missing)", node);
      let acc = this.makeVariant("empty", emptyInfo, []);
      for (let i = elems.length - 1; i >= 0; i--) {
        acc = this.makeVariant("link", linkInfo, [this.compileExpr(elems[i]!, ctx, false), acc]);
      }
      return acc;
    }
    // [raw-array: ...] is the primitive: a $Fields (array (mut anyref)).
    if (ctorName === "raw-array") {
      return this.rawArrayOf(elems.map((e) => this.compileExpr(e, ctx, false)));
    }
    // string-dict / set: desugar to a prelude function over a raw-array. (Done via a
    // plain function rather than a `.make` object so the prelude stays CPS-safe — no
    // object literals/tuples, which the stoppable transform doesn't handle.)
    const dictSetFn =
      (ctorName === "string-dict") ? "sd-from-raw" :
      (ctorName === "mutable-string-dict") ? "mut-sd-from-raw" :
      (ctorName === "set" || ctorName === "list-set" || ctorName === "tree-set") ? "set-from-raw" : null;
    if (dictSetFn) {
      const fn = this.resolveName(dictSetFn, ctx);
      if (fn !== null) {
        const raw = this.rawArrayOf(elems.map((e) => this.compileExpr(e, ctx, false)));
        return this.callClosureValue(fn, [raw], ctx, false);
      }
    }
    // General Pyret construct protocol: [C: e1..en] == C.make([raw-array: e1..en]).
    // The constructor C is a value whose `make` field builds the collection.
    const ctorVal = this.compileExpr(ctorNode, ctx, false);
    const objLocal = ctx.addLocal(binaryen.anyref);
    const fieldLocal = ctx.addLocal(binaryen.anyref);
    const rawLocal = ctx.addLocal(binaryen.anyref);
    const pre = [
      m.local.set(objLocal, ctorVal),
      m.local.set(rawLocal, this.rawArrayOf(elems.map((e) => this.compileExpr(e, ctx, false)))),
      m.local.set(fieldLocal, m.call("$obj_get",
        [m.ref.cast(m.local.get(objLocal, binaryen.anyref), this.t.ObjectRef), this.strLiteralRaw("make")],
        binaryen.anyref)),
    ];
    const field = () => m.local.get(fieldLocal, binaryen.anyref);
    const raw = () => m.local.get(rawLocal, binaryen.anyref);
    const methodClosure = m.call("$method_closure", [m.ref.cast(field(), this.t.MethodRef)], this.t.ClosureRef);
    const methodCall = this.callClosureValue(methodClosure, [m.local.get(objLocal, binaryen.anyref), raw()], ctx, false);
    const plainCall = this.callClosureValue(field(), [raw()], ctx, false);
    return m.block(null, [
      ...pre,
      m.if(m.ref.test(field(), this.t.MethodRefNull), methodCall, plainCall, binaryen.anyref),
    ], binaryen.anyref);
  }

  // Build a raw-array ($Fields) value from compiled element expressions.
  private rawArrayOf(vals: number[]): number {
    return this.m.array.new_fixed(this.t.Fields, vals);
  }

  // { field: expr, method m(self, ...): ... , ... }
  private compileObject(node: CstNode, ctx: Ctx): number {
    const m = this.m;
    const fieldsNode = this.childNamed(node, "obj-fields");
    const fields = fieldsNode ? fieldsNode.kids.filter((k) => k.name === "obj-field") : [];
    const names: number[] = [];
    const values: number[] = [];
    for (const f of fields) {
      const key = this.childNamed(f, "key");
      const nameStr = key ? this.childNamed(key, "NAME")!.value! : this.childNamed(f, "NAME")!.value!;
      names.push(this.strLiteralRaw(nameStr));
      if (f.kids.some((k) => k.name === "METHOD")) {
        const closure = this.buildClosureFromParts(this.headerParamBindings(f), this.childNamed(f, "block")!, ctx, "$mth_");
        values.push(m.struct.new([m.ref.cast(closure, this.t.ClosureRef)], this.t.Method));
      } else {
        const valNode = this.childNamed(f, "binop-expr")!;
        values.push(this.compileExpr(valNode, ctx, false));
      }
    }
    const namesArr = m.array.new_fixed(this.t.Names, names);
    const valuesArr = names.length === 0
      ? m.array.new_fixed(this.t.Fields, [])
      : m.array.new_fixed(this.t.Fields, values);
    return m.call("$make_object", [namesArr, valuesArr], this.t.ObjectRef);
  }

  // `e.{f: v, ...}` — object update: a NEW object that is `e` with the given fields
  // overridden/added (new fields prepended; $obj_extend relies on first-match lookup).
  private compileExtend(node: CstNode, ctx: Ctx): number {
    const m = this.m;
    const objVal = m.ref.cast(this.compileExpr(node.kids[0]!, ctx, false), this.t.ObjectRef);
    const fieldsNode = this.childNamed(node, "fields");
    const fields = fieldsNode ? fieldsNode.kids.filter((k) => k.name === "field") : [];
    const names: number[] = [];
    const values: number[] = [];
    for (const f of fields) {
      const key = this.childNamed(f, "key");
      const nameStr = key ? this.childNamed(key, "NAME")!.value! : this.childNamed(f, "NAME")!.value!;
      names.push(this.strLiteralRaw(nameStr));
      if (f.kids.some((k) => k.name === "METHOD")) {
        const closure = this.buildClosureFromParts(this.headerParamBindings(f), this.childNamed(f, "block")!, ctx, "$mth_");
        values.push(m.struct.new([m.ref.cast(closure, this.t.ClosureRef)], this.t.Method));
      } else {
        values.push(this.compileExpr(this.childNamed(f, "binop-expr")!, ctx, false));
      }
    }
    const nn = m.array.new_fixed(this.t.Names, names);
    const nv = m.array.new_fixed(this.t.Fields, values);
    return m.call("$obj_extend", [objVal, nn, nv], this.t.ObjectRef);
  }

  private compileDot(node: CstNode, ctx: Ctx): number {
    const m = this.m;
    const objExpr = node.kids[0]!;
    const name = this.childNamed(node, "NAME")!.value!;
    // Module-alias field access: `N.foo` -> module N's exported global `foo`.
    {
      const alias = this.moduleAliasName(objExpr);
      if (alias) {
        const r = this.resolveModuleMember(name, alias, ctx);
        if (r === null) throw new CompileError(`unbound module member: ${name}`, node);
        return r;
      }
    }
    // `_` curry: `_.field` -> `lam($c): $c.field end`.
    const curD = this.curryOver(node, [objExpr], ctx);
    if (curD !== null) return curD;
    // Field access by name on a data variant (`n.v`): if any variant has a field
    // named `v`, resolve the index at RUNTIME from the value's actual variant layout
    // (variants of one type can share a name at different indices), via
    // $variant_field_by_name; plain objects still use $obj_get.
    if (this.variantHasField(name)) {
      const tmp = ctx.addLocal(binaryen.anyref);
      const get = () => m.local.get(tmp, binaryen.anyref);
      const vcast = () => m.ref.cast(get(), this.t.VariantRef);
      const names = () => m.ref.cast(
        m.array.get(m.ref.cast(m.global.get("$variant_names", this.t.FieldsRefNull), this.t.FieldsRef),
          m.call("$variant_id", [vcast()], binaryen.i32), binaryen.anyref, false),
        this.t.NamesRef);
      return m.block(null, [
        m.local.set(tmp, this.compileExpr(objExpr, ctx, false)),
        m.if(m.ref.test(get(), this.t.VariantRefNull),
          m.call("$variant_field_by_name", [vcast(), names(), this.strLiteralRaw(name)], binaryen.anyref),
          m.call("$obj_get", [m.ref.cast(get(), this.t.ObjectRef), this.strLiteralRaw(name)], binaryen.anyref),
          binaryen.anyref),
      ], binaryen.anyref);
    }
    const objVal = m.ref.cast(this.compileExpr(objExpr, ctx, false), this.t.ObjectRef);
    return m.call("$obj_get", [objVal, this.strLiteralRaw(name)], binaryen.anyref);
  }

  // ---- `_` curry shorthand: `_.f(a)` / `_ + 1` / `g(_)` -> a lambda over the `_`s ----
  private isUnderscore(node: CstNode): CstNode | null {
    let cur = node;
    while (cur && cur.kids && cur.kids.length === 1 &&
      (cur.name === "expr" || cur.name === "binop-expr" || cur.name === "prim-expr")) {
      cur = cur.kids[0]!;
    }
    if (cur && cur.name === "id-expr" && cur.kids.length === 1 && this.only(cur).value === "_") return cur;
    return null;
  }
  private idExprNode(name: string, pos: CstNode["pos"]): CstNode {
    return { name: "id-expr", pos, kids: [{ name: "NAME", value: name, pos, kids: [] }] };
  }
  // Replace several target nodes (by identity) in ONE clone pass — sequential
  // single-target replaces would clone the tree and invalidate later targets.
  private replaceNodes(root: CstNode, map: Map<CstNode, CstNode>): CstNode {
    const r = map.get(root);
    if (r) return r;
    return { ...root, kids: root.kids.map((k) => this.replaceNodes(k, map)) };
  }
  // If any of `operands` is a bare `_`, build `lam($cur..): <node with _ -> $cur> end`.
  private curryOver(node: CstNode, operands: (CstNode | undefined)[], ctx: Ctx): number | null {
    const map = new Map<CstNode, CstNode>();
    const paramBindings: CstNode[] = [];
    for (const o of operands) {
      const u = o && this.isUnderscore(o);
      if (u) {
        const p = "$cur" + (this.gcount++);
        paramBindings.push({ name: "binding", pos: node.pos, kids: [
          { name: "name-binding", pos: node.pos, kids: [{ name: "NAME", pos: node.pos, kids: [], value: p }] },
        ] });
        map.set(u, this.idExprNode(p, node.pos));
      }
    }
    if (paramBindings.length === 0) return null;
    const body = this.replaceNodes(node, map);
    const block: CstNode = { name: "block", pos: node.pos, kids: [{ name: "stmt", pos: node.pos, kids: [body] }] };
    return this.buildClosureFromParts(paramBindings, block, ctx, "$cur_");
  }

  // Whether any data variant has a field named `name` (so `.name` should attempt
  // runtime variant field-access-by-name).
  private variantHasField(name: string): boolean {
    for (const v of this.variants.values()) if (v.fields.includes(name)) return true;
    return false;
  }

  // Process prelude import/include statements (see compileProgram).
  private processImports(prelude: CstNode | undefined) {
    if (!prelude) return;
    for (const stmt of prelude.kids) {
      if (stmt.name !== "import-stmt") continue;
      // `IMPORT import-source AS NAME` -> record the alias
      const asTok = stmt.kids.find((k) => k.name === "AS");
      if (asTok) {
        const aliasNode = stmt.kids[stmt.kids.length - 1]!;
        // `_` is the wildcard/discard binding (e.g. `import global as _`), not a
        // usable alias — leaving it out also frees `_` for curry shorthand.
        if (aliasNode.name === "NAME" && aliasNode.value !== "_") this.moduleAliases.add(aliasNode.value!);
      }
      // INCLUDE / `import names from src` -> names already global; no-op.
    }
  }

  // If objExpr unwraps to an id-expr naming a module alias, return that name.
  private moduleAliasName(objExpr: CstNode): string | null {
    let cur = objExpr;
    while (cur && cur.kids.length === 1 &&
           (cur.name === "expr" || cur.name === "binop-expr" || cur.name === "prim-expr")) {
      cur = cur.kids[0]!;
    }
    if (cur && cur.name === "id-expr") {
      const n = this.only(cur).value!;
      if (this.moduleAliases.has(n)) return n;
    }
    return null;
  }

  // If `node` unwraps to a dot-expr, return its object expr + field name.
  private asDot(node: CstNode): { objExpr: CstNode; name: string } | null {
    let cur = node;
    while (cur && cur.kids.length === 1 && (cur.name === "expr" || cur.name === "binop-expr" || cur.name === "prim-expr")) {
      cur = cur.kids[0]!;
    }
    if (cur && cur.name === "dot-expr") {
      return { objExpr: cur.kids[0]!, name: this.childNamed(cur, "NAME")!.value! };
    }
    return null;
  }

  // Unwrap an expression to a bare identifier name, if it is one.
  private simpleName(node: CstNode): string | undefined {
    let cur = node;
    while (cur && cur.kids.length === 1 &&
      (cur.name === "binop-expr" || cur.name === "expr" || cur.name === "prim-expr" || cur.name === "id-expr")) {
      if (cur.name === "id-expr") return this.only(cur).value!;
      cur = cur.kids[0]!;
    }
    if (cur && cur.name === "id-expr") return this.only(cur).value!;
    return undefined;
  }

  private compileLambda(node: CstNode, ctx: Ctx): number {
    return this.buildClosureFromParts(this.headerParamBindings(node), this.childNamed(node, "block")!, ctx, "$lam_");
  }

  // for F(x from e1, y from e2): body end  ==>  F(lam(x, y): body end, e1, e2)
  private compileFor(node: CstNode, ctx: Ctx, tail: boolean): number {
    const iterExpr = node.kids.find((k) => k.name === "expr")!;
    const binds = node.kids.filter((k) => k.name === "for-bind");
    const paramBindings = binds.map((b) => this.childNamed(b, "binding")!);
    const body = this.childNamed(node, "block")!;
    const lambda = this.buildClosureFromParts(paramBindings, body, ctx, "$for_");
    const fromArgs = binds.map((b) => this.compileExpr(b.kids.find((k) => k.name === "binop-expr")!, ctx, false));
    const iterClosure = this.compileExpr(iterExpr, ctx, false);
    return this.callClosureValue(iterClosure, [lambda, ...fromArgs], ctx, tail);
  }

  private compileApp(node: CstNode, ctx: Ctx, tail: boolean): number {
    const m = this.m;
    const fnNode = node.kids[0]!;
    const argsNode = this.childNamed(node, "app-args");
    let argExprNodes: CstNode[] = [];
    const optCB = argsNode && this.childNamed(argsNode, "opt-comma-binops");
    const commaB = optCB && this.childNamed(optCB, "comma-binops");
    if (commaB) argExprNodes = commaB.kids.filter((k) => k.name === "binop-expr");

    // direct name? (for variant constructors / predicates)
    let cur = fnNode;
    while (cur && (cur.name === "expr" || cur.name === "id-expr")) {
      if (cur.name === "id-expr") { cur = this.only(cur); break; }
      cur = this.only(cur);
    }
    const name = cur && cur.name === "NAME" ? cur.value! : undefined;

    // method / field call:  obj.m(args)
    const dot = this.asDot(fnNode);
    // `_` curry: `_.m(a)` / `f(_)` / `N.f(_)` -> a lambda over the underscores.
    // For a module-alias call (`N.f(...)`) curry only the ARGS — the object `N` is
    // the alias, not a `_`; otherwise curry the object too.
    const modAlias = dot ? this.moduleAliasName(dot.objExpr) : null;
    const isModAlias = !!modAlias;
    {
      const curOperands = isModAlias ? argExprNodes : [dot ? dot.objExpr : undefined, ...argExprNodes];
      const cur2 = this.curryOver(node, curOperands, ctx);
      if (cur2 !== null) return cur2;
    }
    if (isModAlias) {
      // `N.foo(args)` where N is a module alias -> call module N's export `foo`.
      const args = argExprNodes.map((a) => this.compileExpr(a, ctx, false));
      const intr = this.compileIntrinsic(dot.name, args, ctx);
      if (intr !== null) return intr;
      // A data variant exported by N (e.g. `T.t-name(...)`): construct it directly
      // when the arity matches the variant. This must take precedence over a
      // same-named smart-constructor global alias (`t-name = T.t-name(_, _, ...)`),
      // which would otherwise resolve to itself and recurse forever. A smart
      // constructor used at its OWN (shorter) arity falls through to the global.
      // When we KNOW the module N names, only build the variant N actually exports —
      // if N exports a `fun foo` (not a variant), fall through to call it, even if
      // ANOTHER module happens to define a variant `foo`. Without module info, keep the
      // legacy last-wins variant (so existing single-namespace behavior is unchanged).
      const tgt = this.moduleTargetFor(modAlias);
      const vinfo = tgt !== undefined ? this.variantForMod(dot.name, tgt) : this.variants.get(dot.name);
      if (vinfo && vinfo.fields.length === args.length) {
        return this.makeVariant(dot.name, vinfo, args);
      }
      const g = this.resolveModuleMember(dot.name, modAlias, ctx);
      if (g === null) throw new CompileError(`unbound module member: ${dot.name}`, node);
      return this.callClosureValue(g, args, ctx, tail);
    }
    if (dot) return this.compileMethodCall(dot.objExpr, dot.name, argExprNodes, ctx, tail);

    // stoppable-codegen intrinsics (emitted only by the CPS pass; tail-aware)
    if (name === "yield-check" && argExprNodes.length === 1 && !this.isBound(name, ctx)) {
      return this.compileYieldCheck(this.compileExpr(argExprNodes[0]!, ctx, false), ctx, tail);
    }

    const args = argExprNodes.map((a) => this.compileExpr(a, ctx, false));

    if (name === "finish-result" && args.length === 1 && !this.isBound(name, ctx)) {
      return this.compileFinishResult(args[0]!, ctx);
    }

    // runtime intrinsics (shadowable by user bindings)
    if (name && !this.isBound(name, ctx)) {
      const intr = this.compileIntrinsic(name, args, ctx);
      if (intr !== null) return intr;
    }

    // Fast path: direct construction when arity matches. On a mismatch (e.g. a
    // latent over-application in a never-run visitor branch) fall through to the
    // reified constructor closure, which reads exactly its field count — Pyret
    // defers constructor arity to runtime, so we don't hard-error at compile time.
    //
    // A top-level `shadow X` smart constructor (e.g. pprint's `shadow concat =
    // lam(fst, snd): fst + snd end`, a 2-arg wrapper over the 4-arg `concat`
    // variant) registers a global that shadows the variant. We disambiguate by
    // ARITY: a call matching the variant's field count builds the variant (this is
    // what the data decl's own methods mean by `concat(self, other, 0, true)`, and
    // also type-structs' top-level `t-name(uri, id, dummy, false)`), while the
    // smart-constructor arity falls through to the shadowing global. Only a LOCAL
    // binding (param/let) fully overrides the constructor. This is broader than (and
    // subsumes) restricting variant-preference to method bodies.
    // A BARE same-named variant-vs-`fun` collision ACROSS modules is intentionally NOT
    // re-disambiguated here: the flat namespace has no per-reference module scope, and
    // the real front-end relies on this arity rule selecting the variant. Cross-module
    // disambiguation is instead exact through qualified `N.member` (module-aware; see
    // resolveModuleMember/variantForMod). See test/module-collision.test.ts + the
    // analysis in self-host/NAMESPACE-NOTES.md.
    if (name && this.variants.has(name) && !this.isLocallyBound(name, ctx)
        && this.variants.get(name)!.fields.length === args.length) {
      return this.makeVariant(name, this.variants.get(name)!, args);
    }
    if (name && name.startsWith("is-") && this.variants.has(name.slice(3)) && args.length === 1 && !this.isBound(name, ctx)) {
      const v = this.variants.get(name.slice(3))!;
      const arg = args[0]!;
      return this.mkBool(m.if(m.ref.test(arg, this.t.VariantRefNull),
        m.i32.eq(m.call("$variant_id", [m.ref.cast(arg, this.t.VariantRef)], binaryen.i32), m.i32.const(v.id)),
        m.i32.const(0), binaryen.i32));
    }
    // is-<TypeName>(x): data-type predicate (variant id in the type's range).
    if (name && name.startsWith("is-") && this.dataTypeRanges.has(name.slice(3)) && args.length === 1 && !this.isBound(name, ctx)) {
      const r = this.dataTypeRanges.get(name.slice(3))!;
      const tmp = ctx.addLocal(binaryen.anyref);
      const g = () => m.local.get(tmp, binaryen.anyref);
      const idv = () => m.call("$variant_id", [m.ref.cast(g(), this.t.VariantRef)], binaryen.i32);
      return m.block(null, [
        m.local.set(tmp, args[0]!),
        this.mkBool(m.if(m.ref.test(g(), this.t.VariantRefNull),
          m.i32.and(m.i32.ge_s(idv(), m.i32.const(r.min)), m.i32.le_s(idv(), m.i32.const(r.max))),
          m.i32.const(0), binaryen.i32)),
      ], binaryen.anyref);
    }

    // general closure call
    return this.callClosureValue(this.compileExpr(fnNode, ctx, false), args, ctx, tail);
  }

  // yield-check(thunk): the per-function/loop interrupt point inserted by the CPS
  // pass. Burns one gas tick and tail-calls the thunk to continue; when gas is
  // exhausted, captures the thunk as the resumable continuation and pauses
  // (host throws, unwinding to the trampoline driver). Native tail calls keep the
  // stack flat, so the captured continuation is the entire rest of the program.
  private compileYieldCheck(thunk: number, ctx: Ctx, tail: boolean): number {
    const m = this.m;
    const t = ctx.addLocal(binaryen.anyref);
    const gas = () => m.global.get("$gas", binaryen.i32);
    // The gas check is a (none-typed) statement: out of gas -> stash the
    // continuation and pause (do_pause throws, so the tail-call below is never
    // reached on that path); otherwise just decrement. The tail-call to the
    // thunk then runs unconditionally (only reachable on the has-gas path).
    const pause = m.block(null, [
      m.global.set("$gas", m.i32.const(GAS_RESET)),
      m.global.set("$paused_thunk", m.local.get(t, binaryen.anyref)),
      m.call("$do_pause", [], binaryen.none),
    ]);
    return m.block(null, [
      m.local.set(t, thunk),
      m.if(m.i32.gt_s(gas(), m.i32.const(0)),
        m.global.set("$gas", m.i32.sub(gas(), m.i32.const(1))),
        pause),
      this.callClosureValue(m.local.get(t, binaryen.anyref), [], ctx, tail),
    ], binaryen.anyref);
  }

  // finish-result(v): the halt continuation fed to the top-level CPS expression.
  // Stashes the final value and prints it (matching the non-stoppable path's
  // last-expression printing), then returns nothing.
  private compileFinishResult(value: number, ctx: Ctx): number {
    const m = this.m;
    const v = ctx.addLocal(binaryen.anyref);
    const len = ctx.addLocal(binaryen.i32);
    return m.block(null, [
      m.local.set(v, value),
      m.global.set("$result", m.local.get(v, binaryen.anyref)),
      m.local.set(len, m.call("$val_to_string", [m.local.get(v, binaryen.anyref)], binaryen.i32)),
      m.call("$print", [m.i32.const(SCRATCH_OFFSET), m.local.get(len, binaryen.i32)], binaryen.none),
      m.ref.i31(m.i32.const(2)),
    ], binaryen.anyref);
  }

  // Runtime intrinsics callable by name. Returns null if `name` is not one.
  private compileIntrinsic(name: string, args: number[], ctx: Ctx): number | null {
    const m = this.m;
    if (name === "raise" && args.length === 1) {
      const len = ctx.addLocal(binaryen.i32);
      return m.block(null, [
        m.local.set(len, m.call("$val_to_string", [args[0]!], binaryen.i32)),
        m.call("$raise", [m.i32.const(SCRATCH_OFFSET), m.local.get(len, binaryen.i32)], binaryen.none),
        m.unreachable(),
      ], binaryen.anyref);
    }
    if ((name === "tostring" || name === "to-string" || name === "torepr" || name === "to-repr") && args.length === 1) {
      return m.call("$tostring", [args[0]!], this.t.StrRef);
    }
    if (name === "string-length" && args.length === 1) {
      return m.call("$string_length", [m.ref.cast(args[0]!, this.t.StrRef)], this.t.FixnumRef);
    }
    // time-now(): wall-clock ms. Only used for timing/telemetry in the compiler
    // (elapsed-time diffs), so a deterministic 0 stub is sufficient and avoids a
    // nondeterministic host import.
    if (name === "time-now" && args.length === 0) {
      return m.call("$make_fix", [m.i64.const(0n)], this.t.FixnumRef);
    }
    if (name === "string-to-code-points" && args.length === 1) {
      return m.call("$str_to_codepoints", [m.ref.cast(args[0]!, this.t.StrRef)], binaryen.anyref);
    }
    // 1-char string from a code point (byte). The plural form + the rest of the
    // string library are built on this in the Pyret prelude.
    if (name === "string-from-code-point" && args.length === 1) {
      return m.array.new_fixed(this.t.Str, [m.call("$num_to_i32", [args[0]!], binaryen.i32)]);
    }
    if (name === "num-modulo" && args.length === 2) {
      return m.call("$num_modulo", [this.asNum(args[0]!), this.asNum(args[1]!)], this.t.NumRef);
    }
    if (name === "num-quotient" && args.length === 2) {
      return m.call("$num_quotient", [this.asNum(args[0]!), this.asNum(args[1]!)], this.t.NumRef);
    }
    if (name === "num-expt" && args.length === 2) {
      return m.call("$num_expt", [this.asNum(args[0]!), this.asNum(args[1]!)], this.t.NumRef);
    }
    if (name === "string-equal" && args.length === 2) {
      return this.mkBool(m.call("$str_equal",
        [m.ref.cast(args[0]!, this.t.StrRef), m.ref.cast(args[1]!, this.t.StrRef)], binaryen.i32));
    }
    if (name === "read-source" && args.length === 0) {
      // The self-hosting input path: ask the host to write the program source into
      // scratch memory, then copy it into a Pyret $Str. Returns a String.
      const len = ctx.addLocal(binaryen.i32);
      return m.block(null, [
        m.local.set(len, m.call("$read_source_into", [m.i32.const(SCRATCH_OFFSET)], binaryen.i32)),
        m.call("$str_from_mem", [m.i32.const(SCRATCH_OFFSET), m.local.get(len, binaryen.i32)], this.t.StrRef),
      ], this.t.StrRef);
    }
    if (name === "emit-byte" && args.length === 1) {
      return m.block(null, [
        m.call("$emit_byte", [m.call("$num_to_i32", [args[0]!], binaryen.i32)], binaryen.none),
        m.ref.i31(m.i32.const(2)), // nothing
      ], binaryen.anyref);
    }
    // Self-hosted parser bridge (paired with the host imports + parse-bridge.ts).
    // `parse-num-nodes()` parses the runtime source (precomputed host-side) and
    // returns the flat node count; `parse-node-tag`/`-nkids`/`-str` read node i.
    if (name === "parse-num-nodes" && args.length === 0) {
      return m.call("$make_fix",
        [m.i64.extend_s(m.call("$parse_source", [], binaryen.i32))], this.t.FixnumRef);
    }
    if (name === "parse-node-tag" && args.length === 1) {
      return m.call("$make_fix",
        [m.i64.extend_s(m.call("$parse_node_tag", [m.call("$num_to_i32", [args[0]!], binaryen.i32)], binaryen.i32))],
        this.t.FixnumRef);
    }
    if (name === "parse-node-nkids" && args.length === 1) {
      return m.call("$make_fix",
        [m.i64.extend_s(m.call("$parse_node_nkids", [m.call("$num_to_i32", [args[0]!], binaryen.i32)], binaryen.i32))],
        this.t.FixnumRef);
    }
    if (name === "parse-node-str" && args.length === 1) {
      const len = ctx.addLocal(binaryen.i32);
      return m.block(null, [
        m.local.set(len, m.call("$parse_node_str_into",
          [m.call("$num_to_i32", [args[0]!], binaryen.i32), m.i32.const(SCRATCH_OFFSET)], binaryen.i32)),
        m.call("$str_from_mem", [m.i32.const(SCRATCH_OFFSET), m.local.get(len, binaryen.i32)], this.t.StrRef),
      ], this.t.StrRef);
    }
    if (name === "identical" && args.length === 2) {
      return this.mkBool(m.ref.eq(m.ref.cast(args[0]!, binaryen.eqref), m.ref.cast(args[1]!, binaryen.eqref)));
    }
    // equal-always / equal-now: structural equality (the same runtime fn `==` uses).
    if ((name === "equal-always" || name === "equal-now") && args.length === 2) {
      return this.mkBool(m.call("$equal", [args[0]!, args[1]!], binaryen.i32));
    }
    // string-to-code-point: the (byte) code point of a 1-char string -> a fixnum.
    // (string-to-code-points yields byte values, so this is the singular form.)
    if (name === "string-to-code-point" && args.length === 1) {
      return m.call("$make_fix",
        [m.i64.extend_u(m.array.get(m.ref.cast(args[0]!, this.t.StrRef), m.i32.const(0), binaryen.i32, false))],
        this.t.FixnumRef);
    }
    // Raw arrays = a $Fields (array (mut anyref)). The rest of the raw-array library
    // (to-list/map/each/fold) is built on these in the prelude. Each primitive is
    // also exposed under a `prim-` name so the prelude can wrap it in a first-class
    // `fun raw-array-get(...)` (needed when the name is used as a value, not called)
    // without the wrapper recursing into itself (the wrapper body calls `prim-`).
    if ((name === "raw-array-get" || name === "prim-raw-array-get") && args.length === 2) {
      return m.array.get(m.ref.cast(args[0]!, this.t.FieldsRef),
        m.call("$num_to_i32", [args[1]!], binaryen.i32), binaryen.anyref, false);
    }
    if ((name === "raw-array-length" || name === "prim-raw-array-length") && args.length === 1) {
      return m.call("$make_fix",
        [m.i64.extend_u(m.array.len(m.ref.cast(args[0]!, this.t.FieldsRef)))], this.t.FixnumRef);
    }
    if ((name === "raw-array-set" || name === "prim-raw-array-set") && args.length === 3) {
      const a = ctx.addLocal(binaryen.anyref);
      return m.block(null, [
        m.local.set(a, args[0]!),
        m.array.set(m.ref.cast(m.local.get(a, binaryen.anyref), this.t.FieldsRef),
          m.call("$num_to_i32", [args[1]!], binaryen.i32), args[2]!),
        m.local.get(a, binaryen.anyref),
      ], binaryen.anyref);
    }
    // raw-array-of(elt, n) -> a fresh $Fields of length n, every slot = elt.
    if ((name === "raw-array-of" || name === "prim-raw-array-of") && args.length === 2) {
      return m.array.new(this.t.Fields, m.call("$num_to_i32", [args[1]!], binaryen.i32), args[0]!);
    }
    // Type predicates (value-model). Each returns a Pyret boolean by testing the
    // value's runtime representation. booleans/nothing are i31 (0/1/2).
    if (args.length === 1) {
      const simple: Record<string, binaryen.Type> = {
        "is-string": this.t.StrRefNull,
        "is-number": this.t.NumRefNull,
        "is-function": this.t.ClosureRefNull,
        "is-object": this.t.ObjectRefNull,
        "is-raw-array": this.t.FieldsRefNull,
      };
      if (name in simple) return this.mkBool(m.ref.test(args[0]!, simple[name]!));
      // i31-tag predicates: guard with ref.test i31ref, then read the tag.
      const i31pred = (wantEq: ((g: number) => number)) => {
        const a = ctx.addLocal(binaryen.anyref);
        const get = () => m.local.get(a, binaryen.anyref);
        return m.block(null, [
          m.local.set(a, args[0]!),
          this.mkBool(m.if(m.ref.test(get(), binaryen.i31ref),
            wantEq(m.i31.get_s(m.ref.cast(get(), binaryen.i31ref))),
            m.i32.const(0), binaryen.i32)),
        ], binaryen.anyref);
      };
      if (name === "is-boolean") return i31pred((g) => m.i32.lt_s(g, m.i32.const(2)));
      if (name === "is-nothing") return i31pred((g) => m.i32.eq(g, m.i32.const(2)));
      if (name === "is-tuple") {
        const a = ctx.addLocal(binaryen.anyref);
        const get = () => m.local.get(a, binaryen.anyref);
        return m.block(null, [
          m.local.set(a, args[0]!),
          this.mkBool(m.if(m.ref.test(get(), this.t.VariantRefNull),
            m.i32.eq(m.call("$variant_id", [m.ref.cast(get(), this.t.VariantRef)], binaryen.i32), m.i32.const(0)),
            m.i32.const(0), binaryen.i32)),
        ], binaryen.anyref);
      }
      if (name === "num-to-roughnum") {
        return m.call("$make_rough", [m.call("$to_f64", [this.asNum(args[0]!)], binaryen.f64)], this.t.RoughnumRef);
      }
      if (name === "num-sqrt") {
        return m.call("$make_rough",
          [m.f64.sqrt(m.call("$to_f64", [this.asNum(args[0]!)], binaryen.f64))], this.t.RoughnumRef);
      }
      // number-kind predicates (NUM_TAG: FIX=0, RATIONAL=1, ROUGH=2, BIGNUM=3)
      {
        const tagOf = (x: number) => m.struct.get(0, this.asNum(x), binaryen.i32, false);
        if (name === "num-is-fixnum") return this.mkBool(m.i32.eq(tagOf(args[0]!), m.i32.const(0)));
        if (name === "num-is-rational") return this.mkBool(m.i32.eq(tagOf(args[0]!), m.i32.const(1)));
        if (name === "num-is-roughnum") return this.mkBool(m.i32.eq(tagOf(args[0]!), m.i32.const(2)));
        if (name === "num-is-integer") {
          const v = ctx.addLocal(this.t.NumRef);
          const get = () => m.local.get(v, this.t.NumRef);
          const tag = () => m.struct.get(0, get(), binaryen.i32, false);
          const f = () => m.call("$to_f64", [get()], binaryen.f64);
          return m.block(null, [
            m.local.set(v, this.asNum(args[0]!)),
            this.mkBool(m.i32.or(
              m.i32.or(m.i32.eq(tag(), m.i32.const(0)), m.i32.eq(tag(), m.i32.const(3))),
              m.i32.and(m.i32.eq(tag(), m.i32.const(2)), m.f64.eq(m.f64.floor(f()), f())))),
          ], binaryen.anyref);
        }
      }
      // num-floor/ceiling/round: exact input -> exact integer; roughnum -> roughnum.
      // (Goes through f64, so exact rationals/bignums beyond 2^53 are approximated.)
      {
        const roundOp = (op: "floor" | "ceil" | "nearest", x: number) => {
          const v = ctx.addLocal(this.t.NumRef);
          const get = () => m.local.get(v, this.t.NumRef);
          const rf = () => (m.f64 as any)[op](m.call("$to_f64", [get()], binaryen.f64));
          return m.block(null, [
            m.local.set(v, this.asNum(x)),
            m.if(m.i32.eq(m.struct.get(0, get(), binaryen.i32, false), m.i32.const(2)),
              m.call("$make_rough", [rf()], this.t.RoughnumRef),
              m.call("$make_fix", [m.i64.trunc_s.f64(rf())], this.t.FixnumRef),
              this.t.NumRef),
          ], binaryen.anyref);
        };
        if (name === "num-floor") return roundOp("floor", args[0]!);
        if (name === "num-ceiling") return roundOp("ceil", args[0]!);
        if (name === "num-round") return roundOp("nearest", args[0]!);
      }
      // num-exact: exact passthrough; roughnum -> nearest exact integer (best-effort).
      if (name === "num-exact") {
        const v = ctx.addLocal(this.t.NumRef);
        const get = () => m.local.get(v, this.t.NumRef);
        return m.block(null, [
          m.local.set(v, this.asNum(args[0]!)),
          m.if(m.i32.eq(m.struct.get(0, get(), binaryen.i32, false), m.i32.const(2)),
            m.call("$make_fix", [m.i64.trunc_s.f64(m.f64.nearest(m.call("$to_f64", [get()], binaryen.f64)))], this.t.FixnumRef),
            get(), this.t.NumRef),
        ], binaryen.anyref);
      }
      // num-to-scientific: stub — a plain numeric string (not yet true scientific form).
      if (name === "num-to-scientific") {
        return m.call("$tostring", [this.asNum(args[0]!)], this.t.StrRef);
      }
      // num-to-rational: exact -> passthrough; roughnum -> nearest exact integer (best-effort).
      if (name === "num-to-rational") {
        const v = ctx.addLocal(this.t.NumRef);
        const get = () => m.local.get(v, this.t.NumRef);
        return m.block(null, [
          m.local.set(v, this.asNum(args[0]!)),
          m.if(m.i32.eq(m.struct.get(0, get(), binaryen.i32, false), m.i32.const(2)),
            m.call("$make_fix", [m.i64.trunc_s.f64(m.f64.nearest(m.call("$to_f64", [get()], binaryen.f64)))], this.t.FixnumRef),
            get(), this.t.NumRef),
        ], binaryen.anyref);
      }
    }
    // num-to-string-digits(n, d): stub — ignores the digit count, returns the plain
    // numeric string. (2-arg, so outside the args.length===1 block above.)
    if (name === "num-to-string-digits" && args.length === 2) {
      return m.call("$tostring", [this.asNum(args[0]!)], this.t.StrRef);
    }
    if ((name === "print" || name === "display" || name === "print-error") && args.length === 1) {
      const argLocal = ctx.addLocal(binaryen.anyref);
      const len = ctx.addLocal(binaryen.i32);
      return m.block(null, [
        m.local.set(argLocal, args[0]!),
        m.local.set(len, m.call("$val_to_string", [m.local.get(argLocal, binaryen.anyref)], binaryen.i32)),
        m.call("$print", [m.i32.const(SCRATCH_OFFSET), m.local.get(len, binaryen.i32)], binaryen.none),
        m.local.get(argLocal, binaryen.anyref), // print returns its argument
      ], binaryen.anyref);
    }
    return null;
  }

  // obj.m(args): look up the field; if it's a method, call its closure with
  // self prepended; otherwise call the field value as a plain closure.
  private compileMethodCall(objExpr: CstNode, name: string, argNodes: CstNode[], ctx: Ctx, tail: boolean): number {
    const objVal = this.compileExpr(objExpr, ctx, false);
    const argVals = argNodes.map((a) => this.compileExpr(a, ctx, false));
    return this.compileMethodOnValue(objVal, name, argVals, ctx, tail);
  }

  // Method dispatch on already-compiled values: look up `name` on objVal (variant
  // via the method registry, or a plain object), then call it (as a self-binding
  // $Method, or a plain field-as-closure).
  private compileMethodOnValue(objVal: number, name: string, argVals: number[], ctx: Ctx, tail: boolean): number {
    const m = this.m;
    // `obj._match(handlers, els)` is Pyret's auto-generated data dispatcher (the
    // basis of `.visit()`). It isn't a user method — route it to the runtime
    // `$variant_match`, which dispatches `obj` on `handlers` by variant name.
    if (name === "_match" && argVals.length === 2) {
      const operands = [objVal, argVals[0]!, argVals[1]!];
      return tail
        ? m.return_call("$variant_match", operands, binaryen.anyref)
        : m.call("$variant_match", operands, binaryen.anyref);
    }
    const objLocal = ctx.addLocal(binaryen.anyref);
    const fieldLocal = ctx.addLocal(binaryen.anyref);
    const argLocals = argVals.map(() => ctx.addLocal(binaryen.anyref));
    const prelude: number[] = [m.local.set(objLocal, objVal)];
    argVals.forEach((a, i) => prelude.push(m.local.set(argLocals[i]!, a)));
    // Where to look up the method: a data variant routes through the per-id method
    // registry; a plain object holds its methods directly.
    const obj = () => m.local.get(objLocal, binaryen.anyref);
    const methodsSource = m.if(
      m.ref.test(obj(), this.t.VariantRefNull),
      m.ref.cast(
        m.array.get(m.ref.cast(m.global.get("$variant_methods", this.t.FieldsRefNull), this.t.FieldsRef),
          m.call("$variant_id", [m.ref.cast(obj(), this.t.VariantRef)], binaryen.i32),
          binaryen.anyref, false),
        this.t.ObjectRef),
      m.ref.cast(obj(), this.t.ObjectRef),
      this.t.ObjectRef);
    prelude.push(m.local.set(fieldLocal,
      m.call("$obj_get", [methodsSource, this.strLiteralRaw(name)], binaryen.anyref)));
    const field = () => m.local.get(fieldLocal, binaryen.anyref);
    const argGets = argLocals.map((l) => m.local.get(l, binaryen.anyref));
    const methodClosure = m.call("$method_closure", [m.ref.cast(field(), this.t.MethodRef)], this.t.ClosureRef);
    const methodCall = this.callClosureValue(methodClosure, [m.local.get(objLocal, binaryen.anyref), ...argGets], ctx, tail);
    const plainCall = this.callClosureValue(field(), argGets, ctx, tail);
    return m.block(null, [
      ...prelude,
      m.if(m.ref.test(field(), this.t.MethodRefNull), methodCall, plainCall, binaryen.anyref),
    ], binaryen.anyref);
  }

  // Call a closure *value* (anyref) with already-compiled argument expressions.
  private callClosureValue(closureValue: number, args: number[], ctx: Ctx, tail: boolean): number {
    const m = this.m;
    const closureLocal = ctx.addLocal(this.t.ClosureRef);
    const argsArr = args.length === 0
      ? m.ref.null(this.t.FieldsRefNull)
      : m.array.new_fixed(this.t.Fields, args);
    const fnIdx = m.struct.get(0, m.local.get(closureLocal, this.t.ClosureRef), binaryen.i32, false);
    const operands = [m.local.get(closureLocal, this.t.ClosureRef), argsArr];
    const callExpr = tail
      ? m.return_call_indirect("$tab", fnIdx, operands, this.sig, binaryen.anyref)
      : m.call_indirect("$tab", fnIdx, operands, this.sig, binaryen.anyref);
    return m.block(null, [
      m.local.set(closureLocal, m.ref.cast(closureValue, this.t.ClosureRef)),
      callExpr,
    ], binaryen.anyref);
  }

  // $variant_match(self, handlers, els) — Pyret's auto-generated `_match` (cf.
  // runtime.js makeMatch), the basis of `.visit()`. Dispatch the variant `self` on
  // `handlers` by VARIANT NAME: if handlers has a field with self's variant name,
  // call it with self's fields (a $Method binds handlers as self then takes the
  // fields; a plain function field takes just the fields); otherwise call `els`
  // (a closure) with self. The uniform closure convention (call_indirect with a
  // $Fields args array) lets us forward the variant's field array directly, so no
  // per-arity dispatch is needed. Emitted here (not in the standalone runtime)
  // because it uses the `$tab` function table + the closure signature.
  private emitVariantMatch(): void {
    const m = this.m, t = this.t, I = binaryen.i32;
    const self = () => m.local.get(0, binaryen.anyref);
    const handlers = () => m.local.get(1, binaryen.anyref);
    const els = () => m.local.get(2, binaryen.anyref);
    const v = () => m.local.get(3, t.VariantRef);
    const name = () => m.local.get(4, t.StrRef);
    const flds = () => m.local.get(5, t.FieldsRefNull);
    const ho = () => m.local.get(6, t.ObjectRef);
    const hn = () => m.local.get(7, t.NamesRef);
    const i = () => m.local.get(8, I), n = () => m.local.get(9, I);
    const handler = () => m.local.get(10, binaryen.anyref);
    const args = () => m.local.get(11, t.FieldsRef);
    const flen = () => m.local.get(12, I);
    // tail-call a closure value (set local 13 first to avoid double-eval)
    const callTail = (cloExpr: number, argsArr: number) => m.block(null, [
      m.local.set(13, cloExpr),
      m.return_call_indirect("$tab",
        m.struct.get(0, m.local.get(13, t.ClosureRef), I, false),
        [m.local.get(13, t.ClosureRef), argsArr], this.sig, binaryen.anyref),
    ], binaryen.unreachable);
    // handler is a $Method: call its closure with [handlers] ++ self.fields
    const methodCall = m.block(null, [
      m.local.set(12, m.if(m.ref.is_null(flds()), m.i32.const(0), m.array.len(m.ref.cast(flds(), t.FieldsRef)))),
      m.local.set(11, m.array.new(t.Fields, m.i32.add(m.i32.const(1), flen()), m.ref.null(binaryen.anyref))),
      m.array.set(args(), m.i32.const(0), handlers()),
      m.if(m.i32.gt_s(flen(), m.i32.const(0)),
        m.array.copy(args(), m.i32.const(1), m.ref.cast(flds(), t.FieldsRef), m.i32.const(0), flen())),
      callTail(m.call("$method_closure", [m.ref.cast(handler(), t.MethodRef)], t.ClosureRef), args()),
    ], binaryen.unreachable);
    // handler is a plain function field: call it with self.fields directly
    const plainCall = callTail(m.ref.cast(handler(), t.ClosureRef), flds());
    const found = m.block(null, [
      m.local.set(10, m.array.get(m.struct.get(1, ho(), t.FieldsRef, false), i(), binaryen.anyref, false)),
      m.if(m.ref.test(handler(), t.MethodRefNull), methodCall, plainCall, binaryen.unreachable),
    ], binaryen.unreachable);
    const body = m.block(null, [
      m.local.set(3, m.ref.cast(self(), t.VariantRef)),
      m.local.set(4, m.struct.get(1, v(), t.StrRef, false)),
      m.local.set(5, m.struct.get(2, v(), t.FieldsRefNull, false)),
      m.local.set(6, m.ref.cast(handlers(), t.ObjectRef)),
      m.local.set(7, m.struct.get(0, ho(), t.NamesRef, false)),
      m.local.set(9, m.array.len(hn())),
      m.local.set(8, m.i32.const(0)),
      m.block("search_done", [
        m.loop("lp", m.block(null, [
          m.if(m.i32.ge_s(i(), n()), m.br("search_done")),
          m.if(m.call("$str_equal", [m.array.get(hn(), i(), t.StrRef, false), name()], I), found),
          m.local.set(8, m.i32.add(i(), m.i32.const(1))),
          m.br("lp"),
        ])),
      ]),
      // not found: els(self)
      callTail(m.ref.cast(els(), t.ClosureRef), m.array.new_fixed(t.Fields, [self()])),
    ], binaryen.unreachable);
    m.addFunction("$variant_match",
      binaryen.createType([binaryen.anyref, binaryen.anyref, binaryen.anyref]), binaryen.anyref,
      [t.VariantRef, t.StrRef, t.FieldsRefNull, t.ObjectRef, t.NamesRef, I, I, binaryen.anyref, t.FieldsRef, I, t.ClosureRef],
      body);
  }

  private isBound(name: string, ctx: Ctx): boolean {
    return ctx.locals.has(name) || ctx.params.has(name) || ctx.captures.has(name) || this.topScope.has(name);
  }
  // Bound by a LOCAL (param/let/capture) — not just a top-level global. Used to let
  // a data-variant constructor win over a top-level `shadow` smart-constructor while
  // still honoring local shadowing.
  private isLocallyBound(name: string, ctx: Ctx): boolean {
    return ctx.locals.has(name) || ctx.params.has(name) || ctx.captures.has(name);
  }

  private asNum(expr: number): number { return this.m.ref.cast(expr, this.t.NumRef); }
  private truthy(expr: number): number { return this.m.i31.get_s(this.m.ref.cast(expr, binaryen.i31ref)); }
  private mkBool(i32: number): number { return this.m.ref.i31(i32); }

  private compileBinopExpr(node: CstNode, ctx: Ctx): number {
    const kids = node.kids;
    // `_` curry: `_ + 1` / `2 * _` -> a lambda over the underscore operands.
    const cur = this.curryOver(node, kids.filter((_k, i) => i % 2 === 0), ctx);
    if (cur !== null) return cur;
    let acc = this.compileExpr(kids[0]!, ctx, false);
    for (let i = 1; i + 1 < kids.length; i += 2) {
      const opTok = this.only(kids[i]!);
      // `a ^ f` is reverse application: f(a).  (left-associative chain)
      if (opTok.name === "CARET") {
        const fn = this.compileExpr(kids[i + 1]!, ctx, false);
        acc = this.callClosureValue(fn, [acc], ctx, false);
        continue;
      }
      const right = this.compileExpr(kids[i + 1]!, ctx, false);
      acc = this.applyBinop(opTok.name, acc, right, kids[i]!, ctx);
    }
    return acc;
  }

  private applyBinop(op: string, left: number, right: number, opNode: CstNode, ctx: Ctx): number {
    const m = this.m;
    // Arithmetic/comparison: primitive on numbers (PLUS also on strings), else
    // dispatch to the operator method (_plus/_minus/_lessthan/...) so data and
    // objects can overload operators (e.g. pprint's PPrintDoc._plus).
    if (op === "PLUS") {
      return this.numOrMethod(left, right, ctx, "_plus", true,
        (l, r) => m.call("$plus", [l, r], binaryen.anyref));
    }
    if (ARITH_FN[op]) {
      return this.numOrMethod(left, right, ctx, OP_METHOD[op]!, false,
        (l, r) => m.call(ARITH_FN[op]!, [this.asNum(l), this.asNum(r)], this.t.NumRef));
    }
    if (CMP[op]) {
      return this.numOrMethod(left, right, ctx, OP_METHOD[op]!, false,
        (l, r) => this.mkBool(CMP[op]!(m.call("$num_compare", [this.asNum(l), this.asNum(r)], binaryen.i32), m)));
    }
    if (op === "EQUALEQUAL") return this.mkBool(m.call("$equal", [left, right], binaryen.i32));
    if (op === "NEQ") return this.mkBool(m.i32.eqz(m.call("$equal", [left, right], binaryen.i32)));
    // `and`/`or` MUST short-circuit: `right` only executes in the taken if-branch,
    // so `is-s-op(x) and x.op` won't touch x.op when x isn't an s-op.
    if (op === "AND") return m.if(this.truthy(left), this.mkBool(this.truthy(right)), this.mkBool(m.i32.const(0)), binaryen.anyref);
    if (op === "OR") return m.if(this.truthy(left), this.mkBool(m.i32.const(1)), this.mkBool(this.truthy(right)), binaryen.anyref);
    throw new CompileError(`unsupported binop: ${op}`, opNode);
  }

  // Apply a primitive numeric op when `left` is a number (or string, for PLUS),
  // otherwise call left's operator method. Both operands are stashed in locals
  // so they're evaluated once.
  private numOrMethod(left: number, right: number, ctx: Ctx, methodName: string,
                      allowStr: boolean, prim: (l: number, r: number) => number): number {
    const m = this.m;
    const L = ctx.addLocal(binaryen.anyref);
    const R = ctx.addLocal(binaryen.anyref);
    const lg = () => m.local.get(L, binaryen.anyref);
    const rg = () => m.local.get(R, binaryen.anyref);
    const isNum = m.ref.test(lg(), this.t.NumRefNull);
    const cond = allowStr ? m.i32.or(isNum, m.ref.test(lg(), this.t.StrRefNull)) : isNum;
    return m.block(null, [
      m.local.set(L, left),
      m.local.set(R, right),
      m.if(cond, prim(lg(), rg()), this.dispatchMethodValue(lg(), methodName, [rg()], ctx), binaryen.anyref),
    ], binaryen.anyref);
  }

  // Call value.method(args...) given already-compiled value/arg expressions.
  // Mirrors compileMethodCall's variant-vs-object method lookup + dispatch.
  private dispatchMethodValue(objExpr: number, name: string, argExprs: number[], ctx: Ctx): number {
    const m = this.m;
    const objLocal = ctx.addLocal(binaryen.anyref);
    const fieldLocal = ctx.addLocal(binaryen.anyref);
    const argLocals = argExprs.map(() => ctx.addLocal(binaryen.anyref));
    const prelude: number[] = [m.local.set(objLocal, objExpr)];
    argExprs.forEach((a, i) => prelude.push(m.local.set(argLocals[i]!, a)));
    const obj = () => m.local.get(objLocal, binaryen.anyref);
    const methodsSource = m.if(
      m.ref.test(obj(), this.t.VariantRefNull),
      m.ref.cast(
        m.array.get(m.ref.cast(m.global.get("$variant_methods", this.t.FieldsRefNull), this.t.FieldsRef),
          m.call("$variant_id", [m.ref.cast(obj(), this.t.VariantRef)], binaryen.i32),
          binaryen.anyref, false),
        this.t.ObjectRef),
      m.ref.cast(obj(), this.t.ObjectRef),
      this.t.ObjectRef);
    prelude.push(m.local.set(fieldLocal,
      m.call("$obj_get", [methodsSource, this.strLiteralRaw(name)], binaryen.anyref)));
    const field = () => m.local.get(fieldLocal, binaryen.anyref);
    const argGets = argLocals.map((l) => m.local.get(l, binaryen.anyref));
    const methodClosure = m.call("$method_closure", [m.ref.cast(field(), this.t.MethodRef)], this.t.ClosureRef);
    const methodCall = this.callClosureValue(methodClosure, [obj(), ...argGets], ctx, false);
    const plainCall = this.callClosureValue(field(), argGets, ctx, false);
    return m.block(null, [
      ...prelude,
      m.if(m.ref.test(field(), this.t.MethodRefNull), methodCall, plainCall, binaryen.anyref),
    ], binaryen.anyref);
  }

  private compileIf(node: CstNode, ctx: Ctx, tail: boolean): number {
    const m = this.m;
    const kids = node.kids;
    const cond = kids.find((k) => k.name === "binop-expr")!;
    const blocks = kids.filter((k) => k.name === "block");
    const elseifs = kids.filter((k) => k.name === "else-if");
    const hasElse = kids.some((k) => k.name === "ELSECOLON");

    let elseExpr: number = hasElse
      ? this.compileBlock(blocks[blocks.length - 1]!, ctx, tail)
      : m.call("$no_branch", [], binaryen.anyref);
    for (let i = elseifs.length - 1; i >= 0; i--) {
      const ei = elseifs[i]!;
      const ec = ei.kids.find((k) => k.name === "binop-expr")!;
      const eb = ei.kids.find((k) => k.name === "block")!;
      elseExpr = m.if(this.truthy(this.compileExpr(ec, ctx, false)), this.compileBlock(eb, ctx, tail), elseExpr, binaryen.anyref);
    }
    const thenExpr = this.compileBlock(blocks[0]!, ctx, tail);
    return m.if(this.truthy(this.compileExpr(cond, ctx, false)), thenExpr, elseExpr, binaryen.anyref);
  }

  // `ask: | c1 then: e1 | c2 then: e2 | otherwise: e3 end` -> nested if.
  private compileIfPipe(node: CstNode, ctx: Ctx, tail: boolean): number {
    const m = this.m;
    const branches = node.kids.filter((k) => k.name === "if-pipe-branch");
    const otherIdx = node.kids.findIndex((k) => k.name === "OTHERWISECOLON");
    const elseBlock = otherIdx >= 0 ? node.kids.slice(otherIdx).find((k) => k.name === "block") : undefined;
    let chain: number = elseBlock
      ? this.compileBlock(elseBlock, ctx, tail)
      : m.call("$no_branch", [], binaryen.anyref);
    for (let i = branches.length - 1; i >= 0; i--) {
      const br = branches[i]!;
      const cond = br.kids.find((k) => k.name === "binop-expr")!;
      const body = br.kids.find((k) => k.name === "block")!;
      chain = m.if(this.truthy(this.compileExpr(cond, ctx, false)), this.compileBlock(body, ctx, tail), chain, binaryen.anyref);
    }
    return chain;
  }

  private compileCases(node: CstNode, ctx: Ctx, tail: boolean): number {
    const m = this.m;
    const scrut = node.kids.find((k) => k.name === "binop-expr")!;
    const branches = node.kids.filter((k) => k.name === "cases-branch");
    const elseIdx = node.kids.findIndex((k) => k.name === "ELSE");
    const elseBlock = elseIdx >= 0 ? node.kids.slice(elseIdx).find((k) => k.name === "block") : undefined;

    // Compile the scrutinee FIRST, while the surrounding scope is intact — a
    // branch may bind a field whose name shadows the scrutinee variable.
    const scrutCompiled = m.ref.cast(this.compileExpr(scrut, ctx, false), this.t.VariantRef);

    const scrutLocal = ctx.addLocal(this.t.VariantRef);
    const idLocal = ctx.addLocal(binaryen.i32);
    const scrutGet = () => m.local.get(scrutLocal, this.t.VariantRef);

    let chain: number = elseBlock
      ? this.compileBlock(elseBlock, ctx, tail)
      : m.call("$cases_no_match", [], binaryen.anyref);

    for (let i = branches.length - 1; i >= 0; i--) {
      const br = branches[i]!;
      const vname = this.childNamed(br, "NAME")!.value!;
      const info = this.variants.get(vname);
      // Real Pyret tolerates a cases branch naming a variant that isn't a
      // constructor of the scrutinee's type — a dead branch that can never match
      // (e.g. ast-anf.arr's `cases(ALettable) ... | a-array` where ALettable has
      // no a-array variant). Drop it (never-matching) instead of erroring.
      if (!info) continue;
      const argsNode = this.childNamed(br, "cases-args");
      const bindings = argsNode ? argsNode.kids.filter((k) => k.name === "cases-binding") : [];
      // Branch-local bindings must not leak to other branches or the outer scope.
      const savedLocals = new Map(ctx.locals);
      const prep: number[] = [];
      bindings.forEach((cb, j) => {
        // bind the j-th field to this pattern binding (name or tuple-destructure).
        const cbBinding = this.childNamed(cb, "binding") ?? cb;
        const fieldVal = m.call("$variant_field", [scrutGet(), m.i32.const(j)], binaryen.anyref);
        this.emitBinding(cbBinding, fieldVal, ctx, prep);
      });
      const branchBlock = this.childNamed(br, "block")!;
      const branchBody = m.block(null, [...prep, this.compileBlock(branchBlock, ctx, tail)], binaryen.anyref);
      ctx.locals = savedLocals; // restore scope
      chain = m.if(m.i32.eq(m.local.get(idLocal, binaryen.i32), m.i32.const(info.id)), branchBody, chain, binaryen.anyref);
    }

    return m.block(null, [
      m.local.set(scrutLocal, scrutCompiled),
      m.local.set(idLocal, m.call("$variant_id", [scrutGet()], binaryen.i32)),
      chain,
    ], binaryen.anyref);
  }

  private compileCheckExpr(node: CstNode, ctx: Ctx): number {
    const m = this.m;
    const block = this.childNamed(node, "block")!;
    const stmts = block.kids.filter((k) => k.name === "stmt");
    const parts: number[] = [];
    stmts.forEach((stmt, i) => {
      this.emitStmt(this.stmtInner(stmt), ctx, false, false, parts);
    });
    return m.block(null, parts);
  }

  // Unified statement compiler used by all block kinds (function bodies, if/cases
  // branches, check blocks). Pushes side-effecting statements (and, when isLast,
  // the block's value) onto `parts`. Returns whether a value was pushed.
  private emitStmt(inner: CstNode, ctx: Ctx, tail: boolean, isLast: boolean, parts: number[]): boolean {
    const m = this.m;
    const nothing = () => m.ref.i31(m.i32.const(2));
    switch (inner.name) {
      case "let-expr":
      case "var-expr":
      case "rec-expr":
        parts.push(this.compileLet(inner, ctx));
        if (isLast) { parts.push(nothing()); return true; }
        return false;
      case "fun-expr":
        parts.push(this.compileLocalFun(inner, ctx));
        if (isLast) { parts.push(nothing()); return true; }
        return false;
      case "data-expr":
        this.registerData(inner);
        if (isLast) { parts.push(nothing()); return true; }
        return false;
      case "type-expr":
      case "newtype-expr":
      case "contract-stmt":
        // type aliases / contracts: erased (we don't type-check yet)
        if (isLast) { parts.push(nothing()); return true; }
        return false;
      case "when-expr": {
        const cond = inner.kids.find((k) => k.name === "binop-expr")!;
        const body = inner.kids.find((k) => k.name === "block")!;
        parts.push(m.if(this.truthy(this.compileExpr(cond, ctx, false)),
          m.drop(this.compileBlock(body, ctx, false))));
        if (isLast) { parts.push(nothing()); return true; }
        return false;
      }
      case "check-expr":
        parts.push(this.compileCheckExpr(inner, ctx));
        if (isLast) { parts.push(nothing()); return true; }
        return false;
      case "check-test":
        if (inner.kids.length > 1) {
          parts.push(this.compileCheckTest(inner, ctx));
          if (isLast) { parts.push(nothing()); return true; }
          return false;
        }
        // fallthrough: single-child check-test is a bare expression
      default: {
        const value = this.compileExpr(inner, ctx, isLast && tail);
        if (isLast) { parts.push(value); return true; }
        parts.push(m.drop(value));
        return false;
      }
    }
  }

  private compileCheckTest(node: CstNode, ctx: Ctx): number {
    const m = this.m;
    const lhs = node.kids[0]!;
    const opNode = node.kids[1]!;
    const rhs = node.kids[2]!;
    const op = this.only(opNode).name;
    if (op === "IS") return m.call("$check_is", [this.compileExpr(lhs, ctx, false), this.compileExpr(rhs, ctx, false)], binaryen.none);
    if (op === "ISNOT") return m.call("$check_is_not", [this.compileExpr(lhs, ctx, false), this.compileExpr(rhs, ctx, false)], binaryen.none);
    if (op === "SATISFIES" || op === "SATISFIESNOT") {
      // lhs satisfies pred  ->  check that pred(lhs) is true (violates = negate)
      const l = this.compileExpr(lhs, ctx, false);
      const predCall = this.callClosureValue(this.compileExpr(rhs, ctx, false), [l], ctx, false);
      const t = this.truthy(predCall);
      return m.call("$check_pred", [op === "SATISFIESNOT" ? m.i32.eqz(t) : t], binaryen.none);
    }
    if (op === "RAISES" || op === "RAISESNOT") {
      // lhs raises msg  ->  run lhs in try/catch (via host), expect an error
      // whose message contains the rendered rhs.  RAISESNOT inverts.
      const thunk = this.buildThunkFromExpr(lhs, ctx, "$rai_");
      const len = ctx.addLocal(binaryen.i32);
      const raised = m.call("$check_raises", [m.i32.const(SCRATCH_OFFSET), m.local.get(len, binaryen.i32)], binaryen.i32);
      return m.block(null, [
        m.global.set("$pending_thunk", thunk),
        m.local.set(len, op === "RAISESNOT" ? m.i32.const(0)
          : m.call("$val_to_string", [this.compileExpr(rhs, ctx, false)], binaryen.i32)),
        m.call("$check_pred", [op === "RAISESNOT" ? m.i32.eqz(raised) : raised], binaryen.none),
      ]);
    }
    throw new CompileError(`unsupported check operator: ${op}`, opNode);
  }

  // The binding node of a let/var/rec statement (var/rec have a leading keyword).
  private letBinding(node: CstNode): CstNode {
    return this.childNamed(node, "toplevel-binding") ?? this.childNamed(node, "binding") ?? node.kids[0]!;
  }

  private compileLet(letExpr: CstNode, ctx: Ctx): number {
    const binding = this.letBinding(letExpr);
    const value = this.compileExpr(letExpr.kids[letExpr.kids.length - 1]!, ctx, false);
    // emitBinding handles both a plain name and tuple destructuring `{a; b} = e`.
    // (a captured `var` is boxed in a shared cell — see resolveName/unbox.)
    const parts: number[] = [];
    this.emitBinding(binding, value, ctx, parts);
    return parts.length === 1 ? parts[0]! : this.m.block(null, parts, binaryen.none);
  }

  // `let a = e1, b = e2 (block|:) body end` / `letrec ...`. Desugar to a block whose
  // statements are the bindings followed by the body's statements (reusing emitStmt's
  // let/var/rec handling + block scoping). letrec's mutual recursion is handled by the
  // same forward-capable local scoping the seed uses for local `fun`s.
  // multi-let wraps each binding in a `let-binding` node (-> let-expr|var-expr); letrec
  // lists `let-expr` directly. Collect the actual binding nodes either way.
  private multiLetBinds(node: CstNode): CstNode[] {
    const binds: CstNode[] = [];
    for (const k of node.kids) {
      if (k.name === "let-binding") binds.push(this.only(k));
      else if (k.name === "let-expr" || k.name === "var-expr" || k.name === "rec-expr") binds.push(k);
    }
    return binds;
  }

  private compileMultiLet(node: CstNode, ctx: Ctx, tail: boolean): number {
    const m = this.m;
    const binds = this.multiLetBinds(node);
    const body = this.childNamed(node, "block")!;
    if (node.name === "letrec-expr") {
      // letrec: all names are in scope for every bind value (mutual recursion). Pre-declare
      // each as a boxed cell so closures capture the cell by reference, then fill the cells.
      const parts: number[] = [];
      const names = binds.map((b) => this.bindingName(this.letBinding(b)));
      names.forEach((name) => {
        const idx = ctx.addLocal(binaryen.anyref);
        ctx.locals.set(name, idx);
        ctx.boxed.add(name);
        parts.push(m.local.set(idx, this.makeBox(m.ref.i31(m.i32.const(2))))); // placeholder
      });
      binds.forEach((b, i) => {
        const value = this.compileExpr(b.kids[b.kids.length - 1]!, ctx, false);
        parts.push(this.setBox(this.resolveName(names[i]!, ctx, /*raw*/ true)!, value));
      });
      parts.push(this.compileBlock(body, ctx, tail));
      return m.block(null, parts, binaryen.anyref);
    }
    // multi-let: sequential bindings desugar to a block (bindings then body statements).
    const bindStmts: CstNode[] = binds.map((b) => ({ name: "stmt", pos: b.pos, kids: [b] }));
    const bodyStmts = body.kids.filter((k) => k.name === "stmt");
    const merged: CstNode = { name: "block", pos: node.pos, kids: [...bindStmts, ...bodyStmts] };
    return this.compileBlock(merged, ctx, tail);
  }

  private compileBlock(block: CstNode, ctx: Ctx, tail: boolean): number {
    const m = this.m;
    const stmts = block.kids.filter((k) => k.name === "stmt");
    const parts: number[] = [];
    let hasValue = false;
    // HOIST local `fun` names: pre-allocate a boxed cell per local fun in this block
    // so forward AND mutual references resolve (e.g. a sibling fun used before its
    // definition). The cell is captured by every sibling closure; we fill it when the
    // fun statement is compiled (letrec-style). Self-recursion falls out for free.
    const inners = stmts.map((s) => this.stmtInner(s));
    const hoisted = new Set<string>();
    for (const inner of inners) {
      if (inner.name !== "fun-expr") continue;
      const nm = this.childNamed(inner, "NAME")?.value;
      if (!nm) continue;
      const idx = ctx.addLocal(binaryen.anyref);
      ctx.locals.set(nm, idx);
      ctx.boxed.add(nm);
      hoisted.add(nm);
      parts.push(m.local.set(idx, this.makeBox(m.ref.i31(m.i32.const(2)))));
    }
    stmts.forEach((stmt, i) => {
      const inner = inners[i]!;
      const isLast = i === stmts.length - 1;
      const fnNm = inner.name === "fun-expr" ? this.childNamed(inner, "NAME")?.value : undefined;
      if (fnNm && hoisted.has(fnNm)) {
        // fill the pre-allocated cell with the closure (all siblings already in scope)
        const closure = this.buildClosureFromParts(
          this.headerParamBindings(inner), this.childNamed(inner, "block")!, ctx, "$lfn_");
        parts.push(this.setBox(m.local.get(ctx.locals.get(fnNm)!, binaryen.anyref), closure));
        if (isLast) { parts.push(m.ref.i31(m.i32.const(2))); hasValue = true; }
      } else if (this.emitStmt(inner, ctx, tail, isLast, parts)) {
        hasValue = true;
      }
    });
    if (!hasValue) parts.push(m.ref.i31(m.i32.const(2)));
    return m.block(null, parts, binaryen.anyref);
  }

  private compileLocalFun(fnExpr: CstNode, ctx: Ctx): number {
    const m = this.m;
    const name = this.childNamed(fnExpr, "NAME")!.value!;
    const paramBindings = this.headerParamBindings(fnExpr);
    const params = this.headerParams(fnExpr);
    const body = this.childNamed(fnExpr, "block")!;
    const idx = ctx.addLocal(binaryen.anyref);
    ctx.locals.set(name, idx);
    // Recursive local fun: its name is free in its own body. Box it (a shared cell)
    // so the closure captures the cell, which we then fill with the closure itself —
    // self-reference resolves through the box.
    if (this.freeVars(body, new Set(params)).has(name)) {
      ctx.boxed.add(name);
      const closure = this.buildClosureFromParts(paramBindings, body, ctx, "$lfn_");
      return m.block(null, [
        m.local.set(idx, this.makeBox(m.ref.i31(m.i32.const(2)))),
        this.setBox(m.local.get(idx, binaryen.anyref), closure),
      ]);
    }
    return m.local.set(idx, this.buildClosureFromParts(paramBindings, body, ctx, "$lfn_"));
  }

  private compileNumber(text: string): number {
    const m = this.m;
    let s = text, rough = false;
    if (s.startsWith("~")) { rough = true; s = s.slice(1); }
    if (rough || /[.eE]/.test(s)) return m.call("$make_rough", [m.f64.const(parseFloat(s))], this.t.RoughnumRef);
    return this.intLiteral(BigInt(s));
  }

  // Build an integer $Num literal: Fixnum if it fits i64, else a Bignum.
  private intLiteral(v: bigint): number {
    const m = this.m;
    if (v >= -(2n ** 63n) && v < 2n ** 63n) return m.call("$make_fix", [m.i64.const(v)], this.t.FixnumRef);
    const sign = v < 0n ? -1 : 1;
    let mag = v < 0n ? -v : v;
    const limbs: number[] = [];
    const MASK = 0xffffffffn;
    while (mag > 0n) { limbs.push(m.i32.const(Number(mag & MASK))); mag >>= 32n; }
    const limbsArr = m.array.new_fixed(this.t.Limbs, limbs);
    return m.struct.new([m.i32.const(3 /* BIGNUM */), m.i32.const(sign), limbsArr], this.t.Bignum);
  }

  private compileString(text: string): number {
    let s = text;
    if (s.startsWith("```") && s.endsWith("```")) s = s.slice(3, -3);
    else if (s.length >= 2 && (s[0] === '"' || s[0] === "'")) s = s.slice(1, -1);
    return this.strLiteralRaw(s);
  }

  private compileRational(text: string, rough: boolean): number {
    const m = this.m;
    let s = text;
    if (s.startsWith("~")) s = s.slice(1);
    const [n, d] = s.split("/");
    if (rough) return m.call("$make_rough", [m.f64.const(Number(n) / Number(d))], this.t.RoughnumRef);
    return m.call("$make_rat", [this.intLiteral(BigInt(n!)), this.intLiteral(BigInt(d!))], this.t.NumRef);
  }
}

export function compile(program: CstNode, opts: {
  stoppable?: boolean;
  // Module-awareness for whole-program flattening (build.ts supplies these). Empty =>
  // legacy first/last-wins resolution (single-string builds, no cross-module info).
  stmtMod?: WeakMap<CstNode, number>;          // top-level stmt node -> module id
  aliasMap?: Map<number, Map<string, number>>; // importerMod -> (alias -> targetMod)
} = {}): Uint8Array {
  const c = new Compiler();
  c.stoppable = opts.stoppable ?? false;
  if (opts.stmtMod) c.stmtMod = opts.stmtMod;
  if (opts.aliasMap) c.aliasMap = opts.aliasMap;
  return c.compileProgram(program);
}

// Merge a prelude program's statements ahead of the user program's, producing
// a single combined program CST.
export function mergePrograms(prelude: CstNode, user: CstNode): CstNode {
  const pBlock = prelude.kids.find((k) => k.name === "block")!;
  const uBlock = user.kids.find((k) => k.name === "block")!;
  const mergedBlock: CstNode = {
    name: "block",
    kids: [...pBlock.kids, ...uBlock.kids],
    pos: uBlock.pos,
  };
  // Preserve preludes (imports/provides) from both — the user's imports live here.
  const pPrelude = prelude.kids.find((k) => k.name === "prelude");
  const uPrelude = user.kids.find((k) => k.name === "prelude");
  const mergedPrelude: CstNode = {
    name: "prelude",
    kids: [...(pPrelude?.kids ?? []), ...(uPrelude?.kids ?? [])],
    pos: user.pos,
  };
  return { name: "program", kids: [mergedPrelude, mergedBlock], pos: user.pos };
}
