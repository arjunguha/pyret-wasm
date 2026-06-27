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

interface VariantInfo { id: number; fields: string[]; methods?: { name: string; node: CstNode }[]; }

const ARITH_FN: Record<string, string> = {
  PLUS: "$num_add", DASH: "$num_sub", TIMES: "$num_mul", SLASH: "$num_divide",
};
const CMP: Record<string, (c: number, m: binaryen.Module) => number> = {
  LT: (c, m) => m.i32.lt_s(c, m.i32.const(0)),
  GT: (c, m) => m.i32.gt_s(c, m.i32.const(0)),
  LEQ: (c, m) => m.i32.le_s(c, m.i32.const(0)),
  GEQ: (c, m) => m.i32.ge_s(c, m.i32.const(0)),
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
  nextVariantId = 1;
  topScope = new Map<string, string>(); // pyret name -> wasm global name
  moduleAliases = new Set<string>();    // `import lib as N` -> N (resolved to globals)
  fnNames: string[] = [];               // table entries (index = position)
  ctorFns = new Map<string, number>();  // variant name -> table index of its constructor wrapper
  predFns = new Map<string, number>();  // variant name -> table index of its is-<v> predicate wrapper
  tostringFns = new Map<string, number>(); // tostring/torepr reified as first-class fns
  sig: binaryen.Type;
  gcount = 0;                            // for unique global names
  stoppable = false;                    // stoppable codegen (CPS-transformed input)

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
    const topFuns: { node: CstNode; gname: string; fnIndex: number; wasmName: string }[] = [];
    for (const stmt of stmts) {
      const inner = this.stmtInner(stmt);
      if (inner.name === "data-expr") { this.registerData(inner); continue; }
      if (inner.name === "fun-expr") {
        const name = this.childNamed(inner, "NAME")!.value!;
        const gname = this.freshGlobal(name);
        const fnIndex = this.fnNames.length;
        const wasmName = "$fn_" + this.gcount + "_" + name;
        this.fnNames.push(wasmName);
        topFuns.push({ node: inner, gname, fnIndex, wasmName });
      } else if (inner.name === "let-expr" || inner.name === "var-expr" || inner.name === "rec-expr") {
        this.freshGlobal(this.bindingName(this.letBinding(inner)));
      }
    }

    // Pass 2: compile top-level function bodies (no captures).
    for (const tf of topFuns) {
      this.compileFunction(tf.wasmName, tf.node, new Map());
    }

    // Pass 3: $main — initialize fun globals (hoisted), then run statements.
    const ctx = new Ctx(true);
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
      if (inner.name === "let-expr" || inner.name === "var-expr" || inner.name === "rec-expr") {
        const name = this.bindingName(this.letBinding(inner));
        const gname = this.topScope.get(name)!;
        body.push(m.global.set(gname, this.compileExpr(inner.kids[inner.kids.length - 1]!, ctx, false)));
      } else if (inner.name === "check-expr") {
        body.push(this.compileCheckExpr(inner, ctx));
      } else if (inner.name === "check-test" && inner.kids.length > 1) {
        body.push(this.compileCheckTest(inner, ctx));
      } else {
        const value = this.compileExpr(inner, ctx, false);
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
    return gname;
  }

  // ---- data ----
  private registerData(dataExpr: CstNode) {
    // `sharing:` methods apply to every variant of this data type; per-variant
    // `with:` methods override them by name.
    const sharing = this.childNamed(dataExpr, "data-sharing");
    const shared = sharing ? this.collectMethods(sharing) : [];
    for (const kid of dataExpr.kids) {
      if (kid.name !== "first-data-variant" && kid.name !== "data-variant") continue;
      const own = this.collectMethods(this.childNamed(kid, "data-with"));
      const byName = new Map<string, { name: string; node: CstNode }>();
      for (const s of shared) byName.set(s.name, s);
      for (const o of own) byName.set(o.name, o);
      const methods = [...byName.values()];
      const ctor = this.childNamed(kid, "variant-constructor");
      if (ctor) {
        const name = this.childNamed(ctor, "NAME")!.value!;
        const members = this.childNamed(ctor, "variant-members");
        const fields = members
          ? members.kids.filter((k) => k.name === "variant-member").map((vm) => this.bindingName(this.childNamed(vm, "binding")!))
          : [];
        this.variants.set(name, { id: this.nextVariantId++, fields, methods });
      } else {
        const nm = this.childNamed(kid, "NAME");
        if (nm) this.variants.set(nm.value!, { id: this.nextVariantId++, fields: [], methods });
      }
    }
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
      body.push(m.array.set(reg(), m.i32.const(v.id), this.makeMethodsObject(v.methods!, ctx)));
    }
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
  private makeMethodsObject(methods: { name: string; node: CstNode }[], ctx: Ctx): number {
    const m = this.m;
    const names = methods.map((meth) => this.strLiteralRaw(meth.name));
    const values = methods.map((meth) => {
      const closure = this.buildClosureFromParts(this.headerParams(meth.node), this.childNamed(meth.node, "block")!, ctx, "$vmth_");
      return m.struct.new([m.ref.cast(closure, this.t.ClosureRef)], this.t.Method);
    });
    return m.call("$make_object", [m.array.new_fixed(this.t.Names, names), m.array.new_fixed(this.t.Fields, values)], this.t.ObjectRef);
  }

  private strLiteralRaw(s: string): number {
    const bytes = new TextEncoder().encode(s);
    return this.m.array.new_fixed(this.t.Str, Array.from(bytes, (b) => this.m.i32.const(b)));
  }

  private makeVariant(name: string, info: VariantInfo, args: number[]): number {
    const m = this.m;
    const fields = info.fields.length === 0
      ? m.ref.null(this.t.FieldsRefNull)
      : m.array.new_fixed(this.t.Fields, args);
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

  // All names introduced by a binding (recursively flattening tuple bindings).
  private bindingNames(binding: CstNode): string[] {
    const comps = this.tupleComponents(binding);
    if (comps) return comps.flatMap((c) => this.bindingNames(c));
    return [this.bindingName(binding)];
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
      comps.forEach((c, i) => {
        const field = m.call("$variant_field",
          [m.ref.cast(m.local.get(tmp, binaryen.anyref), this.t.VariantRef), m.i32.const(i)], binaryen.anyref);
        this.emitBinding(c, field, ctx, parts);
      });
    } else {
      const name = this.bindingName(binding);
      const idx = ctx.addLocal(binaryen.anyref);
      ctx.locals.set(name, idx);
      parts.push(m.local.set(idx, ctx.boxed.has(name) ? this.makeBox(value) : value));
    }
  }

  private headerParams(fnLike: CstNode): string[] {
    const header = this.childNamed(fnLike, "fun-header");
    const args = header && this.childNamed(header, "args");
    if (!args) return [];
    return args.kids.filter((k) => k.name === "binding").map((b) => this.bindingName(b));
  }

  // Compile a fun-expr or lambda-expr into a wasm function with the uniform
  // calling convention. `captures` maps captured free-var names -> caps index.
  private compileFunction(wasmName: string, fnLike: CstNode, captures: Map<string, number>) {
    this.compileFunctionParts(wasmName, this.headerParams(fnLike), this.childNamed(fnLike, "block")!, captures);
  }

  private compileFunctionParts(wasmName: string, paramNames: string[], bodyBlock: CstNode, captures: Map<string, number>, inheritedBoxed?: Set<string>) {
    const m = this.m;
    const ctx = new Ctx(false);
    paramNames.forEach((p, i) => ctx.params.set(p, i));
    captures.forEach((idx, name) => ctx.captures.set(name, idx));
    // boxed = vars declared here that nested closures capture, plus boxed vars
    // we inherited as captures (the cell is shared down the closure chain).
    this.boxedVarsFor(bodyBlock).forEach((n) => ctx.boxed.add(n));
    if (inheritedBoxed) inheritedBoxed.forEach((n) => ctx.boxed.add(n));
    // a param can shadow an outer var name; a param is never boxed.
    paramNames.forEach((p) => ctx.boxed.delete(p));
    const body = this.compileBlock(bodyBlock, ctx, true);
    m.addFunction(wasmName, this.sig, binaryen.anyref, ctx.localTypes, body);
  }

  // Build a $Closure value from explicit param names + a body block, computing
  // captures against the enclosing ctx. Used by lambdas, local funs, methods, for.
  private buildClosureFromParts(paramNames: string[], bodyBlock: CstNode, ctx: Ctx, prefix: string): number {
    const free = this.freeVars(bodyBlock, new Set(paramNames));
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
    this.compileFunctionParts(wasmName, paramNames, bodyBlock, capMap, inheritedBoxed);
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
    if (this.topScope.has(name)) return m.global.get(this.topScope.get(name)!, binaryen.anyref);
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

  // ---- free variable analysis ----
  private freeVars(node: CstNode, bound: Set<string>): Set<string> {
    const out = new Set<string>();
    const add = (s: Set<string>) => s.forEach((x) => out.add(x));
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
        if (inner.name === "let-expr") for (const nm of this.bindingNames(this.letBinding(inner))) b2.add(nm);
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
      for (const b of this.multiLetBinds(node)) for (const nm of this.bindingNames(this.letBinding(b))) b2.add(nm);
      for (const k of node.kids) add(this.freeVars(k, b2));
      return out;
    }
    if (node.name === "type-let-expr") {
      const body = this.childNamed(node, "block");
      if (body) add(this.freeVars(body, bound)); // type binds erased
      return out;
    }
    for (const k of node.kids) add(this.freeVars(k, bound));
    return out;
  }

  // ---- mutable-variable capture (boxing) ----
  // A function-local `var` that is captured by a nested closure must live in a
  // shared mutable cell (a 1-element $Fields array): the closure captures the cell
  // by reference, so assignments are visible across the closure boundary. (Top-level
  // vars are globals — already shared — so only function-local vars need boxing.)

  // Names declared via `var` within `node`, NOT descending into nested closures.
  private varDeclsIn(node: CstNode, out: Set<string>): void {
    if (node.name === "lambda-expr" || node.name === "fun-expr") return; // separate scope
    if (node.name === "var-expr") for (const nm of this.bindingNames(this.letBinding(node))) out.add(nm);
    for (const k of node.kids) this.varDeclsIn(k, out);
  }
  // Free variables referenced inside ANY closure nested in `node` (i.e. names a
  // nested lambda/fun would capture from an enclosing scope).
  private freeInNestedClosures(node: CstNode, out: Set<string>): void {
    if (node.name === "lambda-expr" || node.name === "fun-expr") {
      this.freeVars(node, new Set()).forEach((n) => out.add(n));
      // still descend so we also see closures nested inside this one
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
      case "dot-expr":
        return this.compileDot(node, ctx);
      case "for-expr":
        return this.compileFor(node, ctx, tail);
      case "user-block-expr": {
        const blk = this.childNamed(node, "block")!;
        return this.compileBlock(blk, ctx, tail);
      }
      case "inst-expr":
        // generic instantiation `expr<T, ...>` — type args erased
        return this.compileExpr(node.kids[0]!, ctx, tail);
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
        else if (this.topScope.has(nm)) setter = m.global.set(this.topScope.get(nm)!, value);
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
    const ctorName = this.simpleName(ctorNode);
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
        const closure = this.buildClosureFromParts(this.headerParams(f), this.childNamed(f, "block")!, ctx, "$mth_");
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

  private compileDot(node: CstNode, ctx: Ctx): number {
    const m = this.m;
    const objExpr = node.kids[0]!;
    const name = this.childNamed(node, "NAME")!.value!;
    // Module-alias field access: `N.foo` -> the global `foo`.
    if (this.moduleAliasName(objExpr)) {
      const r = this.resolveName(name, ctx);
      if (r === null) throw new CompileError(`unbound module member: ${name}`, node);
      return r;
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
    const params: string[] = [];
    for (const o of operands) {
      const u = o && this.isUnderscore(o);
      if (u) { const p = "$cur" + (this.gcount++); params.push(p); map.set(u, this.idExprNode(p, node.pos)); }
    }
    if (params.length === 0) return null;
    const body = this.replaceNodes(node, map);
    const block: CstNode = { name: "block", pos: node.pos, kids: [{ name: "stmt", pos: node.pos, kids: [body] }] };
    return this.buildClosureFromParts(params, block, ctx, "$cur_");
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
    return this.buildClosureFromParts(this.headerParams(node), this.childNamed(node, "block")!, ctx, "$lam_");
  }

  // for F(x from e1, y from e2): body end  ==>  F(lam(x, y): body end, e1, e2)
  private compileFor(node: CstNode, ctx: Ctx, tail: boolean): number {
    const iterExpr = node.kids.find((k) => k.name === "expr")!;
    const binds = node.kids.filter((k) => k.name === "for-bind");
    const paramNames = binds.map((b) => this.bindingName(this.childNamed(b, "binding")!));
    const body = this.childNamed(node, "block")!;
    const lambda = this.buildClosureFromParts(paramNames, body, ctx, "$for_");
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
    // `_` curry: `_.m(a)` / `f(_)` -> a lambda over the underscores (unless `_` is
    // a real module alias, handled below).
    if (!(dot && this.moduleAliasName(dot.objExpr))) {
      const cur2 = this.curryOver(node, [dot ? dot.objExpr : undefined, ...argExprNodes], ctx);
      if (cur2 !== null) return cur2;
    }
    if (dot && this.moduleAliasName(dot.objExpr)) {
      // `N.foo(args)` where N is a module alias -> call the global `foo`
      const args = argExprNodes.map((a) => this.compileExpr(a, ctx, false));
      const intr = this.compileIntrinsic(dot.name, args, ctx);
      if (intr !== null) return intr;
      if (this.variants.has(dot.name)) {
        const v = this.variants.get(dot.name)!;
        return this.makeVariant(dot.name, v, args);
      }
      const g = this.resolveName(dot.name, ctx);
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
    if (name && this.variants.has(name) && !this.isBound(name, ctx)
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
    if (name === "identical" && args.length === 2) {
      return this.mkBool(m.ref.eq(m.ref.cast(args[0]!, binaryen.eqref), m.ref.cast(args[1]!, binaryen.eqref)));
    }
    // Raw arrays = a $Fields (array (mut anyref)). The rest of the raw-array library
    // (to-list/map/each/fold) is built on these in the prelude.
    if (name === "raw-array-get" && args.length === 2) {
      return m.array.get(m.ref.cast(args[0]!, this.t.FieldsRef),
        m.call("$num_to_i32", [args[1]!], binaryen.i32), binaryen.anyref, false);
    }
    if (name === "raw-array-length" && args.length === 1) {
      return m.call("$make_fix",
        [m.i64.extend_u(m.array.len(m.ref.cast(args[0]!, this.t.FieldsRef)))], this.t.FixnumRef);
    }
    if (name === "raw-array-set" && args.length === 3) {
      const a = ctx.addLocal(binaryen.anyref);
      return m.block(null, [
        m.local.set(a, args[0]!),
        m.array.set(m.ref.cast(m.local.get(a, binaryen.anyref), this.t.FieldsRef),
          m.call("$num_to_i32", [args[1]!], binaryen.i32), args[2]!),
        m.local.get(a, binaryen.anyref),
      ], binaryen.anyref);
    }
    // raw-array-of(elt, n) -> a fresh $Fields of length n, every slot = elt.
    if (name === "raw-array-of" && args.length === 2) {
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
    const m = this.m;
    const objLocal = ctx.addLocal(binaryen.anyref);
    const fieldLocal = ctx.addLocal(binaryen.anyref);
    const argLocals = argNodes.map(() => ctx.addLocal(binaryen.anyref));
    const prelude: number[] = [m.local.set(objLocal, this.compileExpr(objExpr, ctx, false))];
    argNodes.forEach((a, i) => prelude.push(m.local.set(argLocals[i]!, this.compileExpr(a, ctx, false))));
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

  private isBound(name: string, ctx: Ctx): boolean {
    return ctx.locals.has(name) || ctx.params.has(name) || ctx.captures.has(name) || this.topScope.has(name);
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
      acc = this.applyBinop(opTok.name, acc, right, kids[i]!);
    }
    return acc;
  }

  private applyBinop(op: string, left: number, right: number, opNode: CstNode): number {
    const m = this.m;
    if (op === "PLUS") return m.call("$plus", [left, right], binaryen.anyref);
    if (ARITH_FN[op]) return m.call(ARITH_FN[op]!, [this.asNum(left), this.asNum(right)], this.t.NumRef);
    if (CMP[op]) {
      const c = m.call("$num_compare", [this.asNum(left), this.asNum(right)], binaryen.i32);
      return this.mkBool(CMP[op]!(c, m));
    }
    if (op === "EQUALEQUAL") return this.mkBool(m.call("$equal", [left, right], binaryen.i32));
    if (op === "NEQ") return this.mkBool(m.i32.eqz(m.call("$equal", [left, right], binaryen.i32)));
    if (op === "AND") return this.mkBool(m.i32.and(this.truthy(left), this.truthy(right)));
    if (op === "OR") return this.mkBool(m.i32.or(this.truthy(left), this.truthy(right)));
    throw new CompileError(`unsupported binop: ${op}`, opNode);
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
    stmts.forEach((stmt, i) => {
      const isLast = i === stmts.length - 1;
      if (this.emitStmt(this.stmtInner(stmt), ctx, tail, isLast, parts)) hasValue = true;
    });
    if (!hasValue) parts.push(m.ref.i31(m.i32.const(2)));
    return m.block(null, parts, binaryen.anyref);
  }

  private compileLocalFun(fnExpr: CstNode, ctx: Ctx): number {
    const m = this.m;
    const name = this.childNamed(fnExpr, "NAME")!.value!;
    const params = this.headerParams(fnExpr);
    const body = this.childNamed(fnExpr, "block")!;
    const idx = ctx.addLocal(binaryen.anyref);
    ctx.locals.set(name, idx);
    // Recursive local fun: its name is free in its own body. Box it (a shared cell)
    // so the closure captures the cell, which we then fill with the closure itself —
    // self-reference resolves through the box.
    if (this.freeVars(body, new Set(params)).has(name)) {
      ctx.boxed.add(name);
      const closure = this.buildClosureFromParts(params, body, ctx, "$lfn_");
      return m.block(null, [
        m.local.set(idx, this.makeBox(m.ref.i31(m.i32.const(2)))),
        this.setBox(m.local.get(idx, binaryen.anyref), closure),
      ]);
    }
    return m.local.set(idx, this.buildClosureFromParts(params, body, ctx, "$lfn_"));
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

export function compile(program: CstNode, opts: { stoppable?: boolean } = {}): Uint8Array {
  const c = new Compiler();
  c.stoppable = opts.stoppable ?? false;
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
