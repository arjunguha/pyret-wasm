// Pyret -> Pyret CPS transform for *stoppable* codegen.
//
// This is a source-to-source pass: it reads the parsed CST and emits Pyret
// SOURCE TEXT, which is then re-parsed and handed to the ordinary (untouched)
// Pyret -> Wasm compiler. Composing the two keeps the main compiler clean.
//
// Why CPS: the IDE runs user code on the UI thread (no Web Worker), so to stay
// responsive (and to honor a Stop click) the computation must periodically
// return to the JS event loop and then RESUME. CPS reifies "the rest of the
// computation" as a closure, so a pause can capture it, unwind to JS, and a
// later resume can continue. Every function/lambda entry calls `yield-check`,
// which burns a gas tick and, when gas runs out, stashes the continuation and
// pauses. Because the main compiler emits NATIVE proper tail calls, CPS's
// pervasive tail calls don't grow the stack (unlike Stopify's JS trampoline).
//
// Coverage: top-level `fun`/`data` defs + trailing expressions; expression forms
// num/frac/string/bool/id, binops (primitives, not interrupted), if/else(-if),
// application (tail and non-tail), lambda, blocks with `name = e` bindings,
// `[list: ...]` construct, `cases`, `for` loops, and dot field access. Because
// the stdlib prelude (List/Option + map/filter/foldl/each/range/...) is CPS-
// transformed together with user code, built-in HIGHER-ORDER functions are
// themselves interruptible — yet primitives (intrinsics, data constructors,
// bignum ops) are called DIRECTLY and never instrumented. Not yet handled:
// method calls (obj.m(...)), check blocks, object literals with methods.

import type { CstNode } from "../parser/pyret-parser.ts";

// A continuation is either a Pyret identifier naming a continuation function
// (so we can pass it along a tail call WITHOUT allocating a fresh closure —
// this is what gives true constant-space tail recursion), or a meta-level
// function building the continuation body around a value-source.
type Cont =
  | { kind: "var"; name: string }
  | { kind: "fn"; apply: (valueSrc: string) => string };

const OP_SRC: Record<string, string> = {
  PLUS: "+", DASH: "-", TIMES: "*", SLASH: "/",
  LT: "<", GT: ">", LEQ: "<=", GEQ: ">=",
  LEQ_: "<=", GEQ_: ">=",
  EQUALEQUAL: "==", NEQ: "<>",
  AND: "and", OR: "or", SPACESHIP: "<=>",
  // string/other operators kept verbatim where the token doubles as source
};

// Compiler intrinsics: called DIRECTLY (no continuation arg), result feeds k.
// Must match the names handled by compileIntrinsic in compile.ts. Data
// constructors and `is-<ctor>` predicates are added dynamically (see collectData).
const INTRINSICS = new Set([
  "raise", "tostring", "to-string", "torepr", "to-repr",
  "string-length", "string-to-code-points", "string-from-code-point",
  "num-modulo", "num-quotient",
  "raw-array-get", "raw-array-length", "raw-array-set",
  "emit-byte", "identical", "print", "display", "print-error",
]);

export class CpsError extends Error {}

class Cps {
  private g = 0;
  private ctors = new Set<string>(); // data constructor names (primitive calls)
  private funDefs = new Set<string>(); // names defined by `fun` (shadow ctors -> CPS calls)
  // Pyret identifiers can't contain `$`, so use a letter-led, hyphen-free prefix
  // that is very unlikely to collide with user names.
  private gensym(p: string): string { return `${p}cps${this.g++}`; }

  private only(n: CstNode): CstNode {
    if (n.kids.length !== 1) throw new CpsError(`expected single child of ${n.name}, got ${n.kids.length}`);
    return n.kids[0]!;
  }
  private child(n: CstNode, name: string): CstNode | undefined {
    return n.kids.find((k) => k.name === name);
  }

  private bindingName(binding: CstNode): string {
    let n: CstNode | undefined = binding;
    while (n && (n.name === "toplevel-binding" || n.name === "binding" || n.name === "name-binding")) {
      const nm = this.child(n, "NAME");
      if (nm) return nm.value!;
      n = n.kids[0];
    }
    throw new CpsError("could not extract binding name");
  }

  private headerParams(fnLike: CstNode): string[] {
    const header = this.child(fnLike, "fun-header");
    const args = header && this.child(header, "args");
    if (!args) return [];
    return args.kids.filter((k) => k.name === "binding").map((b) => this.bindingName(b));
  }

  private opOf(opNode: CstNode): string {
    const tok = opNode.kids.length === 1 ? opNode.kids[0]! : opNode;
    const src = OP_SRC[tok.name];
    if (src) return src;
    if (tok.value) return tok.value;
    throw new CpsError(`unsupported operator token: ${tok.name}`);
  }

  // Unwrap an expression to a bare identifier name, if it is one.
  private simpleName(node: CstNode): string | undefined {
    let cur: CstNode | undefined = node;
    while (cur && cur.kids.length === 1 &&
      (cur.name === "binop-expr" || cur.name === "expr" || cur.name === "prim-expr" || cur.name === "id-expr")) {
      if (cur.name === "id-expr") return this.only(cur).value!;
      cur = cur.kids[0];
    }
    if (cur && cur.name === "id-expr") return this.only(cur).value!;
    return undefined;
  }

  // If `node` unwraps to a dot-expr, return its object node + field name.
  private asDot(node: CstNode): { objNode: CstNode; name: string } | null {
    let cur: CstNode | undefined = node;
    while (cur && cur.kids.length === 1 &&
      (cur.name === "expr" || cur.name === "binop-expr" || cur.name === "prim-expr")) {
      cur = cur.kids[0];
    }
    if (cur && cur.name === "dot-expr") {
      return { objNode: cur.kids[0]!, name: this.child(cur, "NAME")!.value! };
    }
    return null;
  }

  private isPrim(name: string): boolean {
    // A program-defined `fun` shadows a same-named data constructor, so calls to
    // it must be CPS calls (with a continuation), not direct constructions. This
    // matters because the image library adds common constructor names (triangle,
    // text, line, square, scale, rotate, above, beside, ...) that user functions
    // may share.
    if (this.funDefs.has(name)) return false;
    return INTRINSICS.has(name) || this.ctors.has(name) ||
      (name.startsWith("is-") && this.ctors.has(name.slice(3)));
  }

  // Collect names defined by `fun` (top-level and nested) so they shadow any
  // same-named data constructor in isPrim.
  private collectFunDefs(node: CstNode) {
    if (node.name === "fun-expr") {
      const nm = this.child(node, "NAME");
      if (nm) this.funDefs.add(nm.value!);
    }
    for (const k of node.kids) this.collectFunDefs(k);
  }

  // Collect all data-constructor names so calls to them are emitted as direct
  // (primitive) constructions rather than CPS calls.
  private collectData(node: CstNode) {
    if (node.name === "data-expr") {
      for (const v of node.kids) {
        if (v.name !== "data-variant" && v.name !== "first-data-variant") continue;
        const ctor = this.child(v, "variant-constructor");
        if (ctor) { const nm = this.child(ctor, "NAME"); if (nm) this.ctors.add(nm.value!); }
        else { const nm = this.child(v, "NAME"); if (nm) this.ctors.add(nm.value!); }
      }
    }
    for (const k of node.kids) this.collectData(k);
  }

  // ---- continuation helpers ----
  private applyk(k: Cont, v: string): string {
    return k.kind === "var" ? `${k.name}(${v})` : k.apply(v);
  }
  private reifyk(k: Cont): string {
    if (k.kind === "var") return k.name;
    const x = this.gensym("v");
    return `lam(${x}): ${k.apply(x)} end`;
  }

  // ---- the core transform: emit source that computes `node` and feeds it to k ----
  private T(node: CstNode, k: Cont): string {
    switch (node.name) {
      case "expr":
      case "prim-expr":
        return this.T(this.only(node), k);
      case "check-test":
        if (node.kids.length === 1) return this.T(node.kids[0]!, k);
        throw new CpsError("check-test (is/raises) not supported in CPS");
      case "binop-expr":
        if (node.kids.length === 1) return this.T(node.kids[0]!, k);
        return this.tBinop(node, k);
      case "paren-expr": {
        const inner = this.child(node, "binop-expr");
        if (!inner) throw new CpsError("empty paren-expr");
        return this.T(inner, k);
      }
      case "num-expr":
      case "frac-expr":
      case "rfrac-expr":
        return this.applyk(k, this.only(node).value!);
      case "string-expr":
        return this.applyk(k, this.only(node).value!);
      case "bool-expr":
        return this.applyk(k, this.only(node).name === "TRUE" ? "true" : "false");
      case "id-expr":
        return this.applyk(k, this.only(node).value!);
      case "app-expr":
        return this.tApp(node, k);
      case "if-expr":
        return this.tIf(node, k);
      case "cases-expr":
        return this.tCases(node, k);
      case "for-expr":
        return this.tFor(node, k);
      case "construct-expr":
        return this.tConstruct(node, k);
      case "dot-expr":
        // field access: obj.field — primitive; CPS-evaluate the object.
        return this.T(node.kids[0]!, {
          kind: "fn",
          apply: (vo) => this.applyk(k, `${vo}.${this.child(node, "NAME")!.value!}`),
        });
      case "lambda-expr":
        return this.applyk(k, this.cpsLambda(node));
      case "user-block-expr":
        return this.tBlock(this.child(node, "block")!, k);
      default:
        throw new CpsError(`unsupported expression in CPS: ${node.name}`);
    }
  }

  // CPS-evaluate a list of nodes left-to-right, collecting value-sources, then k.
  private tSeq(nodes: CstNode[], i: number, acc: string[], k: (vs: string[]) => string): string {
    if (i === nodes.length) return k(acc);
    return this.T(nodes[i]!, { kind: "fn", apply: (v) => this.tSeq(nodes, i + 1, [...acc, v], k) });
  }

  private tBinop(node: CstNode, k: Cont): string {
    const kids = node.kids;
    const operands: CstNode[] = [];
    const ops: string[] = [];
    for (let i = 0; i < kids.length; i++) {
      if (i % 2 === 0) operands.push(kids[i]!);
      else ops.push(this.opOf(kids[i]!));
    }
    return this.tSeq(operands, 0, [], (vs) => {
      let e = vs[0]!;
      for (let i = 0; i < ops.length; i++) e = `(${e} ${ops[i]} ${vs[i + 1]})`;
      return this.applyk(k, e);
    });
  }

  private appArgNodes(node: CstNode): CstNode[] {
    const argsNode = this.child(node, "app-args");
    const optCB = argsNode && this.child(argsNode, "opt-comma-binops");
    const commaB = optCB && this.child(optCB, "comma-binops");
    return commaB ? commaB.kids.filter((k) => k.name === "binop-expr") : [];
  }

  private tApp(node: CstNode, k: Cont): string {
    const fnNode = node.kids[0]!;
    const argNodes = this.appArgNodes(node);

    // method / field call: obj.m(args) — call the field value with a continuation.
    const dot = this.asDot(fnNode);
    if (dot) {
      return this.T(dot.objNode, {
        kind: "fn",
        apply: (vo) => this.tSeq(argNodes, 0, [], (vs) =>
          `${vo}.${dot.name}(${[...vs, this.reifyk(k)].join(", ")})`),
      });
    }

    // primitive call (intrinsic or data constructor): no continuation, feed to k.
    const fname = this.simpleName(fnNode);
    if (fname && this.isPrim(fname)) {
      return this.tSeq(argNodes, 0, [], (vs) => this.applyk(k, `${fname}(${vs.join(", ")})`));
    }

    // general CPS call: pass an extra trailing continuation argument (this is the
    // tail call -> native return_call; if k is a plain variable, no new closure).
    return this.tSeq([fnNode, ...argNodes], 0, [], (vs) => {
      const vf = vs[0]!;
      const va = vs.slice(1);
      return `${vf}(${[...va, this.reifyk(k)].join(", ")})`;
    });
  }

  private tConstruct(node: CstNode, k: Cont): string {
    const ctorNode = this.child(node, "binop-expr")!;
    const ctorName = this.simpleName(ctorNode) ?? "list";
    const trailing = this.child(node, "trailing-opt-comma-binops");
    const cb = trailing && this.child(trailing, "comma-binops");
    const elems = cb ? cb.kids.filter((x) => x.name === "binop-expr") : [];
    return this.tSeq(elems, 0, [], (vs) => this.applyk(k, `[${ctorName}: ${vs.join(", ")}]`));
  }

  private tIf(node: CstNode, k: Cont): string {
    const kids = node.kids;
    const cond = kids.find((x) => x.name === "binop-expr")!;
    const blocks = kids.filter((x) => x.name === "block");
    const elseifs = kids.filter((x) => x.name === "else-if");
    const hasElse = kids.some((x) => x.name === "ELSECOLON");
    if (!hasElse) throw new CpsError("if-expression without else not supported in CPS");

    // The whole `if` is the continuation of the condition's value, so a call in
    // the condition correctly wraps the entire if-expression.
    const ifExpr = (vc: string, kf: Cont): string => {
      let src = `if ${vc}: ` + this.tBlock(blocks[0]!, kf);
      for (const ei of elseifs) {
        const ec = ei.kids.find((x) => x.name === "binop-expr")!;
        const eb = ei.kids.find((x) => x.name === "block")!;
        src += ` else if ${this.renderPure(ec)}: ` + this.tBlock(eb, kf);
      }
      src += " else: " + this.tBlock(blocks[blocks.length - 1]!, kf) + " end";
      return src;
    };

    if (k.kind === "var") {
      return this.T(cond, { kind: "fn", apply: (vc) => ifExpr(vc, k) });
    }
    // bind k once (a fresh continuation fn) so it isn't duplicated across branches
    const kf = this.gensym("k");
    const inner = this.T(cond, { kind: "fn", apply: (vc) => ifExpr(vc, { kind: "var", name: kf }) });
    return `block: ${kf} = ${this.reifyk(k)} ${inner} end`;
  }

  // render a (simple) type annotation back to source, for cases(Ann).
  private renderAnn(annNode: CstNode | undefined): string {
    if (!annNode) return "Any";
    const findName = (n: CstNode): string | undefined => {
      if (n.name === "NAME") return n.value!;
      for (const k of n.kids) { const r = findName(k); if (r) return r; }
      return undefined;
    };
    return findName(annNode) ?? "Any";
  }

  private tCases(node: CstNode, k: Cont): string {
    const ty = this.renderAnn(this.child(node, "ann"));
    const scrut = node.kids.find((x) => x.name === "binop-expr")!;
    const branches = node.kids.filter((x) => x.name === "cases-branch");
    const elseIdx = node.kids.findIndex((x) => x.name === "ELSE");
    const elseBlock = elseIdx >= 0
      ? node.kids.slice(elseIdx).find((x) => x.name === "block")
      : undefined;

    const emit = (vscrut: string, kf: Cont): string => {
      let src = `cases(${ty}) ${vscrut}:`;
      for (const br of branches) {
        const vname = this.child(br, "NAME")!.value!;
        const argsNode = this.child(br, "cases-args");
        const binds = argsNode
          ? argsNode.kids.filter((x) => x.name === "cases-binding")
            .map((cb) => this.bindingName(this.child(cb, "binding") ?? cb))
          : [];
        const hd = binds.length ? `${vname}(${binds.join(", ")})` : vname;
        src += ` | ${hd} => ` + this.tBlock(this.child(br, "block")!, kf);
      }
      if (elseBlock) src += ` | else => ` + this.tBlock(elseBlock, kf);
      src += " end";
      return src;
    };

    if (k.kind === "var") {
      return this.T(scrut, { kind: "fn", apply: (vc) => emit(vc, k) });
    }
    const kf = this.gensym("k");
    const inner = this.T(scrut, { kind: "fn", apply: (vc) => emit(vc, { kind: "var", name: kf }) });
    return `block: ${kf} = ${this.reifyk(k)} ${inner} end`;
  }

  // for ITER(p1 from e1, ...): body end  ==>  ITER(lam(p1,...): body end, e1, ...)
  // with both ITER and the body-lambda CPS-transformed (so the loop is interruptible).
  private tFor(node: CstNode, k: Cont): string {
    const iterExpr = node.kids.find((x) => x.name === "expr")!;
    const binds = node.kids.filter((x) => x.name === "for-bind");
    const params = binds.map((b) => this.bindingName(this.child(b, "binding")!));
    const fromExprs = binds.map((b) => b.kids.find((x) => x.name === "binop-expr")!);
    const body = this.child(node, "block")!;
    const kg = this.gensym("k");
    const lamBody = this.tBlock(body, { kind: "var", name: kg });
    const lam = `lam(${[...params, kg].join(", ")}): yield-check(lam(): ${lamBody} end) end`;
    return this.T(iterExpr, {
      kind: "fn",
      apply: (vIter) => this.tSeq(fromExprs, 0, [], (vs) =>
        `${vIter}(${[lam, ...vs, this.reifyk(k)].join(", ")})`),
    });
  }

  // Render a call-free expression to source (used only for else-if conditions,
  // which sit outside the value position the CPS continuation threads through).
  private renderPure(node: CstNode): string {
    switch (node.name) {
      case "expr":
      case "prim-expr":
        return this.renderPure(this.only(node));
      case "binop-expr":
        if (node.kids.length === 1) return this.renderPure(node.kids[0]!);
        {
          let e = this.renderPure(node.kids[0]!);
          for (let i = 1; i + 1 < node.kids.length; i += 2)
            e = `(${e} ${this.opOf(node.kids[i]!)} ${this.renderPure(node.kids[i + 1]!)})`;
          return e;
        }
      case "paren-expr":
        return `(${this.renderPure(this.child(node, "binop-expr")!)})`;
      case "dot-expr":
        return `${this.renderPure(node.kids[0]!)}.${this.child(node, "NAME")!.value!}`;
      case "num-expr": case "frac-expr": case "rfrac-expr": case "string-expr":
        return this.only(node).value!;
      case "bool-expr":
        return this.only(node).name === "TRUE" ? "true" : "false";
      case "id-expr":
        return this.only(node).value!;
      default:
        throw new CpsError(`call in pure position not supported in CPS: ${node.name}`);
    }
  }

  // Transform a block (sequence of statements) feeding its value to k.
  private tBlock(block: CstNode, k: Cont): string {
    const stmts = block.kids.filter((x) => x.name === "stmt").map((s) => this.only(s));
    return this.tStmts(stmts, 0, k);
  }

  private tStmts(stmts: CstNode[], i: number, k: Cont): string {
    if (stmts.length === 0) return this.applyk(k, "nothing");
    const last = i === stmts.length - 1;
    const s = stmts[i]!;
    if (s.name === "let-expr" || s.name === "var-expr" || s.name === "rec-expr") {
      const name = this.bindingName(this.child(s, "toplevel-binding") ?? this.child(s, "binding") ?? s.kids[0]!);
      const valNode = s.kids[s.kids.length - 1]!;
      return this.T(valNode, {
        kind: "fn",
        apply: (v) => `block: ${name} = ${v} ${this.tStmts(stmts, i + 1, k)} end`,
      });
    }
    if (s.name === "fun-expr") {
      // local function definition inside a block
      const def = this.cpsFunDef(s);
      return `block: ${def} ${this.tStmts(stmts, i + 1, k)} end`;
    }
    if (s.name === "data-expr") {
      return `block: ${this.renderData(s)} ${this.tStmts(stmts, i + 1, k)} end`;
    }
    if (last) return this.T(s, k);
    // non-final expression statement: evaluate for effect, drop value
    return this.T(s, { kind: "fn", apply: (_v) => this.tStmts(stmts, i + 1, k) });
  }

  // fun NAME(params): body end  ->  fun NAME(params, KG): yield-check(lam(): <body feeding KG> end) end
  private cpsFunDef(fnExpr: CstNode): string {
    const name = this.child(fnExpr, "NAME")!.value!;
    const params = this.headerParams(fnExpr);
    const kg = this.gensym("k");
    const body = this.tBlock(this.child(fnExpr, "block")!, { kind: "var", name: kg });
    const allParams = [...params, kg].join(", ");
    return `fun ${name}(${allParams}): yield-check(lam(): ${body} end) end`;
  }

  private cpsLambda(node: CstNode): string {
    const params = this.headerParams(node);
    const kg = this.gensym("k");
    const body = this.tBlock(this.child(node, "block")!, { kind: "var", name: kg });
    const allParams = [...params, kg].join(", ");
    return `lam(${allParams}): yield-check(lam(): ${body} end) end`;
  }

  // data definitions are NOT transformed (their constructors are primitives);
  // reconstruct the declaration source so it survives to the main compiler.
  private renderData(node: CstNode): string {
    const tyName = this.child(node, "NAME")!.value!;
    const variants = node.kids.filter((k) => k.name === "data-variant" || k.name === "first-data-variant");
    const parts = variants.map((v) => {
      const ctor = this.child(v, "variant-constructor");
      if (ctor) {
        const nm = this.child(ctor, "NAME")!.value!;
        const members = this.child(ctor, "variant-members");
        const fields = members
          ? members.kids.filter((k) => k.name === "variant-member").map((vm) => this.bindingName(this.child(vm, "binding")!))
          : [];
        return `${nm}(${fields.join(", ")})`;
      }
      return this.child(v, "NAME")!.value!;
    });
    return `data ${tyName}: ${parts.map((p) => "| " + p).join(" ")} end`;
  }

  // ---- top level ----
  transform(program: CstNode): string {
    this.collectData(program);
    this.collectFunDefs(program);
    const block = this.child(program, "block");
    if (!block) throw new CpsError("no block in program");
    const stmts = block.kids.filter((x) => x.name === "stmt").map((s) => this.only(s));
    const decls: string[] = []; // top-level data + fun definitions
    const rest: CstNode[] = [];
    for (const s of stmts) {
      if (s.name === "data-expr") decls.push(this.renderData(s));
      else if (s.name === "fun-expr") decls.push(this.cpsFunDef(s));
      else rest.push(s);
    }
    const driver = rest.length === 0
      ? "finish-result(nothing)"
      : this.tStmts(rest, 0, { kind: "fn", apply: (v) => `finish-result(${v})` });
    return decls.join("\n") + (decls.length ? "\n" : "") + driver + "\n";
  }
}

export function cpsSource(program: CstNode): string {
  return new Cps().transform(program);
}
