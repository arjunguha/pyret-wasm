// CST -> simplified-AST serialization for the self-hosted parser (Option B in
// self-host/parser-plan.md). The seed's JS GLR parser produces a CST; here we
// lower it to a FLAT pre-order array of tagged nodes that the Pyret side
// (self-host/parse-from-tree.arr) reconstructs into real ast.arr AST values via
// the `parse-*` intrinsics (host imports in run.ts read this array).
//
// Only a type import of CstNode is used, so this module is safe to pull into the
// browser bundle (the type is erased at build time).
//
// GROW COVERAGE IN LOCKSTEP: each new form needs a TAGS entry + a lowering case
// here AND a matching `build-node` case in self-host/parse-from-tree.arr.
import type { CstNode } from "../parser/parse-core.ts";

// Tag codes shared with self-host/parse-from-tree.arr. Keep in sync on both sides.
export const TAGS = {
  PROGRAM: 0, // str = "all" if `provide *`, kids = [IMPORTS, BLOCK]
  BLOCK: 1,
  NUM: 2,
  STR: 3,
  BOOL: 4,
  ID: 5,
  OP: 6,
  APP: 7, // s-app: kids = [fn-expr, EXPRS(args)]
  DOT: 8, // s-dot: str = field, kids = [obj-expr]
  IF: 9, // s-if / s-if-else: kids = [IFBRANCHES, else-block?]
  LET: 10, // s-let: str = name, kids = [value]
  VAR: 11, // s-var: str = name, kids = [value]
  FUN: 12, // s-fun: str = name, kids = [BINDS(args), body-block]
  LAM: 13, // s-lam: kids = [BINDS(args), body-block]
  CONSTRUCT: 14, // s-construct: kids = [constructor-expr, EXPRS(values)]
  CHECKTEST: 15, // s-check-test: str = op kind, kids = [left, right]
  EXPRS: 16, // helper: a List<Expr> (kids)
  BINDS: 17, // helper: a List<Bind> (BIND kids)
  BIND: 18, // helper: s-bind, str = name, kids = [ann?] (a-blank if absent)
  // --- round 2 ---
  ANAME: 19, // a-name annotation: str = type name
  ABLANK: 20, // a-blank annotation
  DATA: 21, // s-data: str = name, kids = [VARIANTS]
  VARIANT: 22, // s-variant: str = name, kids = [VMEMBERS]
  SINGLEVARIANT: 23, // s-singleton-variant: str = name
  VARIANTS: 24, // helper: a List<Variant>
  VMEMBERS: 25, // helper: a List<Bind> (wrapped into s-variant-member)
  CASES: 26, // s-cases: kids = [typ-ann, val, BRANCHES]
  CASESELSE: 27, // s-cases-else: kids = [typ-ann, val, BRANCHES, else-block]
  CBRANCH: 28, // s-cases-branch: str = name, kids = [CBINDS, body-block]
  CBINDS: 29, // helper: a List<Bind> (wrapped into s-cases-bind)
  BRANCHES: 30, // helper: a List<CasesBranch>
  TUPLE: 31, // s-tuple: kids = [EXPRS]
  WHEN: 32, // s-when: kids = [test, block]
  FOR: 33, // s-for: kids = [iterator, FORBINDS, body-block]
  FORBIND: 34, // s-for-bind: kids = [bind, value]
  FORBINDS: 35, // helper: a List<ForBind>
  IFBRANCH: 36, // s-if-branch: kids = [cond, body-block]
  IFBRANCHES: 37, // helper: a List<IfBranch>
  IMPORT: 38, // s-import: str = module name, kids = [NAMESTR(alias)]
  INCLUDE: 39, // s-include: str = module name
  IMPORTS: 40, // helper: a List<Import>
  NAMESTR: 41, // helper: carries a raw string (rebuilt as the String itself)
} as const;

// One node of the flat pre-order stream. `nkids` children follow immediately
// (also pre-order). `str` carries the leaf payload (number text, string value,
// "true"/"false", identifier name, "op+"-style operator, a bound name, or a
// check-op kind like "is"); unused -> "".
export interface SerNode {
  tag: number;
  nkids: number;
  str: string;
}

// Intermediate tree (built first, then flattened pre-order to SerNode[]).
interface AstNode {
  tag: number;
  str: string;
  kids: AstNode[];
}

function node(tag: number, str: string, kids: AstNode[] = []): AstNode {
  return { tag, str, kids };
}

function stripStr(v: string): string {
  if (v.startsWith("```") && v.endsWith("```")) return v.slice(3, -3);
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'")) return v.slice(1, -1);
  return v;
}

// Pure single-child wrapper CST nodes we descend through transparently.
const PASS = new Set(["stmt", "expr", "prim-expr", "binop-expr-paren", "app-arg-elt"]);

// The check-op terminal name -> our op-kind string (consumed by parse-from-tree).
function checkOpKind(opNode: CstNode): string {
  const t = opNode.kids[0]?.name ?? "IS";
  switch (t) {
    case "IS": return "is";
    case "ISNOT": return "is-not";
    case "ISEQUALEQUAL": return "is==";
    case "SATISFIES": return "satisfies";
    case "SATISFIESNOT": return "satisfies-not";
    case "RAISES": return "raises";
    default: return "is"; // TODO(grammar): roughly/raises-other/because checks
  }
}

// Lower an `ann` CST node to our annotation AstNode.
function toAnn(annNode: CstNode): AstNode {
  let a = annNode;
  while (a.name === "ann" && a.kids.length === 1) a = a.kids[0]!;
  switch (a.name) {
    case "name-ann":
      return node(TAGS.ANAME, a.kids[0]!.value ?? "");
    default:
      return node(TAGS.ABLANK, ""); // TODO(grammar): arrow/app/dot/tuple/record anns
  }
}

// Lower a `binding` CST node to a BIND (with its annotation if present).
function lowerBinding(b: CstNode): AstNode {
  const name = bindName(b);
  const annNode = findFirst(b, "ann");
  return node(TAGS.BIND, name, annNode ? [toAnn(annNode)] : []);
}

// Lower one expression CST node (descending wrappers) to our AstNode.
function toExpr(orig: CstNode): AstNode {
  let n = orig;
  while (PASS.has(n.name) && n.kids.length === 1) n = n.kids[0]!;
  switch (n.name) {
    case "num-expr":
      return node(TAGS.NUM, n.kids[0]!.value ?? "0");
    case "frac-expr":
      return node(TAGS.NUM, n.kids[0]!.value ?? "0"); // TODO(grammar): keep as fraction
    case "string-expr":
      return node(TAGS.STR, stripStr(n.kids[0]!.value ?? ""));
    case "bool-expr":
      return node(TAGS.BOOL, n.kids[0]!.name === "TRUE" ? "true" : "false");
    case "id-expr":
      return node(TAGS.ID, n.kids[0]!.value ?? "");
    case "paren-expr":
      // ( binop-expr ) — lower the inner expression.
      return toExpr(n.kids.find((k) => k.name === "binop-expr") ?? n.kids[1]!);
    case "binop-expr":
      return binop(n);
    case "check-test":
      return checkTest(n);
    case "app-expr":
      return appExpr(n);
    case "dot-expr": {
      const obj = toExpr(n.kids[0]!);
      const field = n.kids[n.kids.length - 1]!.value ?? "";
      return node(TAGS.DOT, field, [obj]);
    }
    case "if-expr":
      return ifExpr(n);
    case "lambda-expr": {
      const { binds, body } = funParts(n);
      return node(TAGS.LAM, "", [binds, body]);
    }
    case "construct-expr":
      return construct(n);
    case "let-expr": {
      const name = bindName(n.kids.find((k) => k.name === "toplevel-binding")!);
      const value = toExpr(n.kids[n.kids.length - 1]!);
      return node(TAGS.LET, name, [value]);
    }
    case "var-expr": {
      const name = bindName(n.kids.find((k) => k.name === "toplevel-binding")!);
      const value = toExpr(n.kids[n.kids.length - 1]!);
      return node(TAGS.VAR, name, [value]);
    }
    case "fun-expr": {
      const name = n.kids.find((k) => k.name === "NAME")?.value ?? "";
      const { binds, body } = funParts(n);
      return node(TAGS.FUN, name, [binds, body]);
    }
    case "data-expr":
      return dataExpr(n);
    case "cases-expr":
      return casesExpr(n);
    case "when-expr": {
      const test = toExpr(n.kids.find((k) => k.name === "binop-expr")!);
      const body = toBlock(n.kids.find((k) => k.name === "block")!);
      return node(TAGS.WHEN, "", [test, body]);
    }
    case "tuple-expr": {
      const fieldsNode = n.kids.find((k) => k.name === "tuple-fields");
      const fields = fieldsNode ? commaBinops(fieldsNode) : [];
      return node(TAGS.TUPLE, "", [node(TAGS.EXPRS, "", fields)]);
    }
    case "for-expr":
      return forExpr(n);
    default:
      if (n.kids.length === 1) return toExpr(n.kids[0]!);
      throw new Error(`parse-bridge: unhandled CST node '${n.name}'`);
  }
}

// binop-expr: expr (binop expr)* — left-associative fold.
function binop(n: CstNode): AstNode {
  if (n.kids.length === 1) return toExpr(n.kids[0]!);
  let acc = toExpr(n.kids[0]!);
  for (let i = 1; i + 1 < n.kids.length; i += 2) {
    const opTok = n.kids[i]!.kids[0]!; // the operator terminal inside `binop`
    const op = "op" + (opTok.value ?? "?");
    acc = node(TAGS.OP, op, [acc, toExpr(n.kids[i + 1]!)]);
  }
  return acc;
}

// check-test: either a plain expression, or `lhs check-op rhs`.
function checkTest(n: CstNode): AstNode {
  if (n.kids.length === 1) return toExpr(n.kids[0]!);
  const opNode = n.kids.find((k) => k.name === "check-op");
  if (opNode && n.kids.length >= 3) {
    return node(TAGS.CHECKTEST, checkOpKind(opNode), [toExpr(n.kids[0]!), toExpr(n.kids[2]!)]);
  }
  return toExpr(n.kids[0]!); // TODO(grammar): postfix check-op-postfix, `because`
}

// app-expr: fn app-args  (fn may itself be a dot-expr => method call).
function appExpr(n: CstNode): AstNode {
  const fn = toExpr(n.kids[0]!);
  const argsNode = n.kids.find((k) => k.name === "app-args");
  const args = argsNode ? commaBinops(argsNode) : [];
  return node(TAGS.APP, "", [fn, node(TAGS.EXPRS, "", args)]);
}

// construct-expr: [ modifier? ctor : values ]  ->  s-construct.
function construct(n: CstNode): AstNode {
  // The constructor is the first binop-expr; values live in trailing-opt-comma-binops.
  const ctorNode = n.kids.find((k) => k.name === "binop-expr")!;
  const ctor = toExpr(ctorNode);
  const valsNode = n.kids.find((k) => k.name === "trailing-opt-comma-binops");
  const values = valsNode ? commaBinops(valsNode) : [];
  return node(TAGS.CONSTRUCT, "", [ctor, node(TAGS.EXPRS, "", values)]);
}

// data-expr: DATA NAME ty-params : data-variant* data-sharing where? END
function dataExpr(n: CstNode): AstNode {
  const name = n.kids.find((k) => k.name === "NAME")?.value ?? "";
  const variants = n.kids.filter((k) => k.name === "data-variant").map(lowerVariant);
  return node(TAGS.DATA, name, [node(TAGS.VARIANTS, "", variants)]);
  // TODO(grammar): mixins (`deriving`), shared `with:` members, sharing:, where:
}

// data-variant: `| ctor(members) with...` or singleton `| NAME with...`
function lowerVariant(dv: CstNode): AstNode {
  const ctor = dv.kids.find((k) => k.name === "variant-constructor");
  if (ctor) {
    const name = ctor.kids.find((k) => k.name === "NAME")?.value ?? "";
    const membersNode = ctor.kids.find((k) => k.name === "variant-members");
    const binds: AstNode[] = [];
    if (membersNode) {
      for (const vm of membersNode.kids) {
        if (vm.name === "variant-member") {
          const b = findFirst(vm, "binding");
          if (b) binds.push(lowerBinding(b));
        }
      }
    }
    return node(TAGS.VARIANT, name, [node(TAGS.VMEMBERS, "", binds)]);
    // TODO(grammar): mutable members (ref), with-members
  }
  // singleton: the direct NAME child
  const name = dv.kids.find((k) => k.name === "NAME")?.value ?? "";
  return node(TAGS.SINGLEVARIANT, name);
}

// cases-expr: CASES ( ann ) val : branch* (| else => block)? END
function casesExpr(n: CstNode): AstNode {
  const annNode = n.kids.find((k) => k.name === "ann");
  const typ = annNode ? toAnn(annNode) : node(TAGS.ABLANK, "");
  const val = toExpr(n.kids.find((k) => k.name === "binop-expr")!);
  const branches = n.kids.filter((k) => k.name === "cases-branch").map(casesBranch);
  const branchesNode = node(TAGS.BRANCHES, "", branches);
  const hasElse = n.kids.some((k) => k.name === "ELSE");
  if (hasElse) {
    const blocks = n.kids.filter((k) => k.name === "block");
    const elseB = toBlock(blocks[blocks.length - 1]!);
    return node(TAGS.CASESELSE, "", [typ, val, branchesNode, elseB]);
  }
  return node(TAGS.CASES, "", [typ, val, branchesNode]);
}

// cases-branch: | NAME (cases-args)? => block
function casesBranch(b: CstNode): AstNode {
  const name = b.kids.find((k) => k.name === "NAME")?.value ?? "";
  const argsNode = b.kids.find((k) => k.name === "cases-args");
  const binds: AstNode[] = [];
  if (argsNode) {
    for (const cb of argsNode.kids) {
      if (cb.name === "cases-binding") {
        const bind = findFirst(cb, "binding");
        if (bind) binds.push(lowerBinding(bind));
      }
    }
  }
  const body = toBlock(b.kids.find((k) => k.name === "block")!);
  return node(TAGS.CBRANCH, name, [node(TAGS.CBINDS, "", binds), body]);
}

// for-expr: FOR iter ( for-bind* ) return-ann : block END
function forExpr(n: CstNode): AstNode {
  const iter = toExpr(n.kids.find((k) => k.name === "expr")!);
  const forBinds = n.kids.filter((k) => k.name === "for-bind").map((fb) => {
    const bind = lowerBinding(findFirst(fb, "binding")!);
    const value = toExpr(fb.kids.find((k) => k.name === "binop-expr")!);
    return node(TAGS.FORBIND, "", [bind, value]);
  });
  const body = toBlock(n.kids.find((k) => k.name === "block")!);
  return node(TAGS.FOR, "", [iter, node(TAGS.FORBINDS, "", forBinds), body]);
}

// Collect the binop-expr children of a comma-separated list node (descending
// through opt-comma-binops / trailing-opt-comma-binops / comma-binops / tuple
// wrappers).
function commaBinops(n: CstNode): AstNode[] {
  const out: AstNode[] = [];
  function walk(x: CstNode) {
    if (x.name === "binop-expr") { out.push(toExpr(x)); return; }
    for (const k of x.kids) walk(k);
  }
  walk(n);
  return out;
}

// if-expr: IF cond : block (else-if cond : block)* (ELSECOLON block)? END
function ifExpr(n: CstNode): AstNode {
  const branches: AstNode[] = [];
  // First branch: the direct cond + first direct block.
  const directBlocks = n.kids.filter((k) => k.name === "block");
  const firstCond = toExpr(n.kids.find((k) => k.name === "binop-expr")!);
  branches.push(node(TAGS.IFBRANCH, "", [firstCond, toBlock(directBlocks[0]!)]));
  // else-if branches (each nests its own cond + block).
  for (const ei of n.kids.filter((k) => k.name === "else-if")) {
    const c = toExpr(ei.kids.find((k) => k.name === "binop-expr")!);
    const b = toBlock(ei.kids.find((k) => k.name === "block")!);
    branches.push(node(TAGS.IFBRANCH, "", [c, b]));
  }
  const branchesNode = node(TAGS.IFBRANCHES, "", branches);
  const hasElse = n.kids.some((k) => k.name === "ELSECOLON");
  if (hasElse) {
    // The else block is the last DIRECT block (else-if blocks are nested).
    return node(TAGS.IF, "", [branchesNode, toBlock(directBlocks[directBlocks.length - 1]!)]);
  }
  return node(TAGS.IF, "", [branchesNode]);
}

// A `block` CST -> our BLOCK node of lowered statements.
function toBlock(n: CstNode): AstNode {
  return node(TAGS.BLOCK, "", n.kids.map(toExpr));
}

// Shared fun/lam parts: the arg binds + the body block.
function funParts(n: CstNode): { binds: AstNode; body: AstNode } {
  const header = n.kids.find((k) => k.name === "fun-header");
  const argsNode = header?.kids.find((k) => k.name === "args");
  const binds: AstNode[] = [];
  if (argsNode) {
    for (const k of argsNode.kids) {
      if (k.name === "binding") binds.push(lowerBinding(k));
    }
  }
  const body = toBlock(n.kids.find((k) => k.name === "block")!);
  return { binds: node(TAGS.BINDS, "", binds), body };
}

// The bound NAME inside a `toplevel-binding` / `binding` / `name-binding`.
function bindName(n: CstNode): string {
  const nm = findFirst(n, "NAME");
  return nm?.value ?? "_";
}

function findFirst(n: CstNode, name: string): CstNode | undefined {
  if (n.name === name) return n;
  for (const k of n.kids) {
    const r = findFirst(k, name);
    if (r) return r;
  }
  return undefined;
}

// Lower the program `prelude` (provide / import / include statements).
function lowerPrelude(prelude: CstNode): { provideFlag: string; imports: AstNode[] } {
  let provideFlag = "";
  const imports: AstNode[] = [];
  for (const stmt of prelude.kids) {
    if (stmt.name === "provide-stmt") {
      // `provide *` -> provide-all. Other provide forms are TODO(grammar).
      if (findFirst(stmt, "TIMES")) provideFlag = "all";
      continue;
    }
    if (stmt.name === "import-stmt") {
      const isInclude = stmt.kids[0]?.name === "INCLUDE";
      const srcName = findFirst(stmt, "import-name");
      const modName = srcName ? (findFirst(srcName, "NAME")?.value ?? "") : "";
      if (!modName) continue; // TODO(grammar): import file("...") / import-special
      if (isInclude) {
        imports.push(node(TAGS.INCLUDE, modName));
      } else {
        // alias = the NAME after `as` (a direct child of import-stmt)
        const alias = stmt.kids.find((k) => k.name === "NAME")?.value ?? modName;
        imports.push(node(TAGS.IMPORT, modName, [node(TAGS.NAMESTR, alias)]));
      }
    }
  }
  return { provideFlag, imports };
}

function flatten(n: AstNode, out: SerNode[]): void {
  out.push({ tag: n.tag, nkids: n.kids.length, str: n.str });
  for (const k of n.kids) flatten(k, out);
}

// Lower a full `program` CST into the flat pre-order SerNode stream.
export function serializeCst(program: CstNode): SerNode[] {
  const prelude = program.kids.find((k) => k.name === "prelude");
  const { provideFlag, imports } = prelude ? lowerPrelude(prelude) : { provideFlag: "", imports: [] };
  const block = program.kids.find((k) => k.name === "block");
  const stmts = block ? block.kids.map(toExpr) : [];
  const root = node(TAGS.PROGRAM, provideFlag, [
    node(TAGS.IMPORTS, "", imports),
    node(TAGS.BLOCK, "", stmts),
  ]);
  const out: SerNode[] = [];
  flatten(root, out);
  return out;
}
