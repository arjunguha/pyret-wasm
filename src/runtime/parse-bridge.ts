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
  // --- round 3 ---
  FRAC: 42, // s-frac: str = "num/den"
  IFPIPE: 43, // s-if-pipe: kids = [PIPEBRANCHES]
  IFPIPEELSE: 44, // s-if-pipe-else: kids = [PIPEBRANCHES, else-block]
  PIPEBRANCH: 45, // s-if-pipe-branch: kids = [test, body-block]
  PIPEBRANCHES: 46, // helper: a List<IfPipeBranch>
  AARROW: 47, // a-arrow: kids = [ANNS(args), ret-ann]
  AAPP: 48, // a-app: kids = [base-ann, ANNS(args)]
  ADOT: 49, // a-dot: str = obj name, kids = [NAMESTR(field)]
  ATUPLE: 50, // a-tuple: kids = [ANNS(fields)]
  ANNS: 51, // helper: a List<Ann>
  IMPORTFILE: 52, // s-import of s-special-import: str = path, kids = [NAMESTR(alias)]
  VMEMBER: 53, // s-variant-member: str = "ref"|"normal", kids = [BIND]
  METHODFIELD: 54, // s-method-field: str = name, kids = [BINDS(args), body-block]
  MEMBERS: 55, // helper: a List<Member> (with: / sharing:)
  DATAFIELD: 56, // s-data-field: str = name, kids = [value]
  OBJ: 57, // s-obj: kids = [MEMBERS]
  // --- round 4 ---
  ARECORD: 58, // a-record: kids = [AFIELDS]
  AFIELD: 59, // a-field: str = name, kids = [ann]
  AFIELDS: 60, // helper: a List<AField>
  APRED: 61, // a-pred: kids = [base-ann, pred-expr]
  USERBLOCK: 62, // s-user-block: kids = [body-block]
  TEMPLATE: 63, // s-template (`...`)
  PAREN: 64, // s-paren: kids = [expr]
  SPYBLOCK: 65, // s-spy-block: str = "msg" if a message is present, kids = [msg?, SPYFIELDS]
  SPYFIELD: 66, // s-spy-expr (explicit `name: val`): str = name, kids = [value]
  SPYFIELDIMPL: 67, // s-spy-expr (shorthand `id`): str = name, kids = [value]
  SPYFIELDS: 68, // helper: a List<SpyField>
  INCLUDEFILE: 69, // s-include of s-special-import: str = path
  PROVIDEBLOCK: 70, // s-provide-block: kids = [PSPECS]
  PSPEC: 71, // s-provide-name: str = name
  PSPECS: 72, // helper: a List<ProvideSpec>
  // --- round 5 (corpus blockers) ---
  CHECK: 73, // s-check: str = "check"|"examples" (keyword-check), kids = [body] | [NAMESTR(name), body]
  TYPE: 74, // s-type: str = name, kids = [ann]
  ASSIGN: 75, // s-assign: str = name, kids = [value]
  INST: 76, // s-instantiate: kids = [expr, ANNS(params)]
  UPDATE: 77, // s-update: kids = [supe, MEMBERS]
  TABLE: 78, // s-table: kids = [HEADERS, ROWS]
  FIELDNAME: 79, // s-field-name: str = name
  HEADERS: 80, // helper: a List<FieldName>
  TABLEROW: 81, // s-table-row: kids = [EXPRS(elems)]
  ROWS: 82, // helper: a List<TableRow>
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

// All `ann` CST nodes found under `n` (one level of comma-anns / arg lists).
function annList(n: CstNode): AstNode[] {
  const out: AstNode[] = [];
  function walk(x: CstNode) {
    if (x.name === "ann") { out.push(toAnn(x)); return; }
    for (const k of x.kids) walk(k);
  }
  walk(n);
  return out;
}

// Lower an `ann` CST node to our annotation AstNode.
function toAnn(annNode: CstNode): AstNode {
  let a = annNode;
  while (a.name === "ann" && a.kids.length === 1) a = a.kids[0]!;
  switch (a.name) {
    case "name-ann":
      return node(TAGS.ANAME, a.kids[0]!.value ?? "");
    case "arrow-ann": {
      // ( arrow-ann-args -> ret ) : args are the comma-anns; ret is the last ann.
      const argsNode = a.kids.find((k) => k.name === "arrow-ann-args");
      const args = argsNode ? annList(argsNode) : [];
      const anns = a.kids.filter((k) => k.name === "ann");
      const ret = toAnn(anns[anns.length - 1]!);
      return node(TAGS.AARROW, "", [node(TAGS.ANNS, "", args), ret]);
    }
    case "app-ann": {
      // base-name-ann < comma-anns > : base is the leading name-ann.
      const base = toAnn(a.kids.find((k) => k.name === "name-ann")!);
      const argsNode = a.kids.find((k) => k.name === "comma-anns");
      const args = argsNode ? annList(argsNode) : [];
      return node(TAGS.AAPP, "", [base, node(TAGS.ANNS, "", args)]);
    }
    case "dot-ann": {
      // NAME . NAME : obj then field.
      const names = a.kids.filter((k) => k.name === "NAME");
      return node(TAGS.ADOT, names[0]?.value ?? "", [
        node(TAGS.NAMESTR, names[1]?.value ?? ""),
      ]);
    }
    case "tuple-ann":
      return node(TAGS.ATUPLE, "", [node(TAGS.ANNS, "", annList(a))]);
    case "record-ann": {
      // { NAME :: ann (, NAME :: ann)* } -> a-record of a-field.
      const fields: AstNode[] = [];
      (function walkAF(x: CstNode) {
        if (x.name === "ann-field") {
          const nm = x.kids.find((k) => k.name === "NAME")?.value ?? "";
          const annK = x.kids.find((k) => k.name === "ann");
          fields.push(node(TAGS.AFIELD, nm, [annK ? toAnn(annK) : node(TAGS.ABLANK, "")]));
          return;
        }
        for (const k of x.kids) walkAF(k);
      })(a);
      return node(TAGS.ARECORD, "", [node(TAGS.AFIELDS, "", fields)]);
    }
    case "pred-ann": {
      // base-ann % ( id-expr ) -> a-pred.
      const baseAnn = a.kids.find((k) => k.name === "ann");
      const idE = a.kids.find((k) => k.name === "id-expr");
      return node(TAGS.APRED, "", [
        baseAnn ? toAnn(baseAnn) : node(TAGS.ABLANK, ""),
        idE ? toExpr(idE) : node(TAGS.ID, ""),
      ]);
    }
    default:
      return node(TAGS.ABLANK, ""); // TODO(grammar): app-ann with dot-ann base
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
      return node(TAGS.FRAC, n.kids[0]!.value ?? "0/1"); // RATIONAL "num/den"
    case "string-expr":
      return node(TAGS.STR, stripStr(n.kids[0]!.value ?? ""));
    case "bool-expr":
      return node(TAGS.BOOL, n.kids[0]!.name === "TRUE" ? "true" : "false");
    case "id-expr":
      return node(TAGS.ID, n.kids[0]!.value ?? "");
    case "paren-expr":
      // ( binop-expr ) -> s-paren of the inner expression.
      return node(TAGS.PAREN, "", [toExpr(n.kids.find((k) => k.name === "binop-expr") ?? n.kids[1]!)]);
    case "user-block-expr":
      // block: ... end -> s-user-block of the inner block.
      return node(TAGS.USERBLOCK, "", [toBlock(n.kids.find((k) => k.name === "block")!)]);
    case "template-expr":
      return node(TAGS.TEMPLATE, "");
    case "spy-stmt":
      return spyStmt(n);
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
      return node(TAGS.LAM, "", withWhere([binds, body], n));
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
      return node(TAGS.FUN, name, withWhere([binds, body], n));
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
    case "if-pipe-expr":
      return ifPipe(n);
    case "obj-expr":
      return node(TAGS.OBJ, "", [
        node(TAGS.MEMBERS, "", lowerFields(n, "obj-fields", "obj-field")),
      ]);
    case "check-expr":
      return checkExpr(n);
    case "type-expr": {
      // TYPE NAME ty-params = ann  ->  s-type (params dropped for now).
      const name = n.kids.find((k) => k.name === "NAME")?.value ?? "";
      const annNode = n.kids.find((k) => k.name === "ann");
      return node(TAGS.TYPE, name, [annNode ? toAnn(annNode) : node(TAGS.ABLANK, "")]);
    }
    case "assign-expr": {
      // NAME := binop-expr  ->  s-assign.
      const name = n.kids.find((k) => k.name === "NAME")?.value ?? "";
      const value = toExpr(n.kids.find((k) => k.name === "binop-expr")!);
      return node(TAGS.ASSIGN, name, [value]);
    }
    case "inst-expr": {
      // expr < ann (, ann)* >  ->  s-instantiate.
      const base = toExpr(n.kids.find((k) => k.name === "expr")!);
      const params = n.kids.filter((k) => k.name === "ann").map(toAnn);
      return node(TAGS.INST, "", [base, node(TAGS.ANNS, "", params)]);
    }
    case "update-expr": {
      // expr ! { fields }  ->  s-update (fields are s-data-field members).
      const supe = toExpr(n.kids.find((k) => k.name === "expr")!);
      const members = lowerFields(n);
      return node(TAGS.UPDATE, "", [supe, node(TAGS.MEMBERS, "", members)]);
    }
    case "table-expr":
      return tableExpr(n);
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

// check-expr: `check:`/`check "name":`/`examples:` block END  ->  s-check.
function checkExpr(n: CstNode): AstNode {
  const isExamples = n.kids.some((k) => k.name === "EXAMPLESCOLON");
  const keyword = isExamples ? "examples" : "check"; // keyword-check boolean
  const body = toBlock(n.kids.find((k) => k.name === "block")!);
  const strNode = n.kids.find((k) => k.name === "STRING");
  if (strNode) {
    return node(TAGS.CHECK, keyword, [node(TAGS.NAMESTR, stripStr(strNode.value ?? "")), body]);
  }
  return node(TAGS.CHECK, keyword, [body]);
}

// table-expr: TABLE table-headers table-rows END  ->  s-table.
function tableExpr(n: CstNode): AstNode {
  const headers: AstNode[] = [];
  const headersNode = n.kids.find((k) => k.name === "table-headers");
  if (headersNode) {
    (function walkH(x: CstNode) {
      if (x.name === "table-header") {
        headers.push(node(TAGS.FIELDNAME, x.kids.find((k) => k.name === "NAME")?.value ?? ""));
        return;
      }
      for (const k of x.kids) walkH(k);
    })(headersNode);
  }
  const rows: AstNode[] = [];
  const rowsNode = n.kids.find((k) => k.name === "table-rows");
  if (rowsNode) {
    for (const r of rowsNode.kids) {
      if (r.name !== "table-row") continue;
      const itemsNode = r.kids.find((k) => k.name === "table-items");
      const elems = itemsNode ? commaBinops(itemsNode) : [];
      rows.push(node(TAGS.TABLEROW, "", [node(TAGS.EXPRS, "", elems)]));
    }
  }
  return node(TAGS.TABLE, "", [node(TAGS.HEADERS, "", headers), node(TAGS.ROWS, "", rows)]);
}

// data-expr: DATA NAME ty-params : data-variant* data-with? data-sharing where? END
function dataExpr(n: CstNode): AstNode {
  const name = n.kids.find((k) => k.name === "NAME")?.value ?? "";
  const variants = n.kids.filter((k) => k.name === "data-variant").map(lowerVariant);
  // sharing: members live under data-sharing's `fields`.
  const sharingNode = n.kids.find((k) => k.name === "data-sharing");
  const shared = sharingNode ? lowerFields(sharingNode) : [];
  // NB: this grammar has no `deriving`/mixins production — s-data's mixins are
  // always empty from surface syntax.
  return node(TAGS.DATA, name, withWhere([
    node(TAGS.VARIANTS, "", variants),
    node(TAGS.MEMBERS, "", shared),
  ], n));
}

// data-variant: `| ctor(members) with:...` or singleton `| NAME with:...`
function lowerVariant(dv: CstNode): AstNode {
  const ctor = dv.kids.find((k) => k.name === "variant-constructor");
  // with: members (on either the constructor or singleton variant)
  const withNode = dv.kids.find((k) => k.name === "data-with");
  const withMembers = withNode ? lowerFields(withNode) : [];
  if (ctor) {
    const name = ctor.kids.find((k) => k.name === "NAME")?.value ?? "";
    const membersNode = ctor.kids.find((k) => k.name === "variant-members");
    const members: AstNode[] = [];
    if (membersNode) {
      for (const vm of membersNode.kids) {
        if (vm.name === "variant-member") {
          const b = findFirst(vm, "binding");
          if (!b) continue;
          const isRef = vm.kids.some((k) => k.name === "REF");
          members.push(node(TAGS.VMEMBER, isRef ? "ref" : "normal", [lowerBinding(b)]));
        }
      }
    }
    return node(TAGS.VARIANT, name, [
      node(TAGS.VMEMBERS, "", members),
      node(TAGS.MEMBERS, "", withMembers),
    ]);
  }
  // singleton: the direct NAME child (may still carry with: members)
  const name = dv.kids.find((k) => k.name === "NAME")?.value ?? "";
  return node(TAGS.SINGLEVARIANT, name, [node(TAGS.MEMBERS, "", withMembers)]);
}

// One `field` / `obj-field` CST node -> a Member node (s-method-field or
// s-data-field). Method fields carry the METHOD keyword + a fun-header.
function lowerField(f: CstNode): AstNode | null {
  const keyName = findFirst(f, "key")?.kids[0]?.value
    ?? f.kids.find((k) => k.name === "NAME")?.value ?? "";
  if (f.kids.some((k) => k.name === "METHOD")) {
    const { binds, body } = funParts(f);
    return node(TAGS.METHODFIELD, keyName, withWhere([binds, body], f));
  }
  // data field `k: value` -> s-data-field.
  const valNode = f.kids.find((k) => k.name === "binop-expr");
  return valNode ? node(TAGS.DATAFIELD, keyName, [toExpr(valNode)]) : null;
}

// A `data-with` / `data-sharing` (or `obj-expr`) node's fields -> Member nodes.
function lowerFields(container: CstNode, listName = "fields", fieldName = "field"): AstNode[] {
  const fieldsNode = findFirst(container, listName);
  if (!fieldsNode) return [];
  const out: AstNode[] = [];
  for (const f of fieldsNode.kids) {
    if (f.name !== fieldName) continue;
    const m = lowerField(f);
    if (m) out.push(m);
  }
  return out;
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

// if-pipe-expr (`ask:`): ASK : if-pipe-branch* (| otherwise: block)? END
// if-pipe-branch: | cond then: block
function ifPipe(n: CstNode): AstNode {
  const branches = n.kids
    .filter((k) => k.name === "if-pipe-branch")
    .map((b) => {
      const cond = toExpr(b.kids.find((k) => k.name === "binop-expr")!);
      const body = toBlock(b.kids.find((k) => k.name === "block")!);
      return node(TAGS.PIPEBRANCH, "", [cond, body]);
    });
  const branchesNode = node(TAGS.PIPEBRANCHES, "", branches);
  // `| otherwise: block` => the trailing block that isn't inside a branch.
  if (n.kids.some((k) => k.name === "OTHERWISECOLON")) {
    const blocks = n.kids.filter((k) => k.name === "block");
    const elseB = toBlock(blocks[blocks.length - 1]!);
    return node(TAGS.IFPIPEELSE, "", [branchesNode, elseB]);
  }
  return node(TAGS.IFPIPE, "", [branchesNode]);
}

// A `block` CST -> our BLOCK node of lowered statements.
function toBlock(n: CstNode): AstNode {
  return node(TAGS.BLOCK, "", n.kids.map(toExpr));
}

// Append the where-clause body block (if any) as a trailing kid, so the rebuild
// side can populate `_check` on s-fun/s-lam/s-method-field.
function withWhere(kids: AstNode[], n: CstNode): AstNode[] {
  const wc = n.kids.find((k) => k.name === "where-clause");
  const blk = wc?.kids.find((k) => k.name === "block");
  return blk ? [...kids, toBlock(blk)] : kids;
}

// spy-stmt: SPY [message] : (spy-field (, spy-field)*)? END  ->  s-spy-block.
function spyStmt(n: CstNode): AstNode {
  const msg = n.kids.find((k) => k.name === "binop-expr"); // optional message expr
  const contents = n.kids.find((k) => k.name === "spy-contents");
  const fields: AstNode[] = [];
  if (contents) {
    for (const sf of contents.kids) {
      if (sf.name !== "spy-field") continue;
      const valNode = sf.kids.find((k) => k.name === "binop-expr");
      if (valNode) {
        // `name: value` -> explicit field.
        const nm = sf.kids.find((k) => k.name === "NAME")?.value ?? "";
        fields.push(node(TAGS.SPYFIELD, nm, [toExpr(valNode)]));
      } else {
        // shorthand `id` -> implicit-label field (name = the id).
        const idE = sf.kids.find((k) => k.name === "id-expr");
        const nm = idE?.kids[0]?.value ?? "";
        fields.push(node(TAGS.SPYFIELDIMPL, nm, [toExpr(idE!)]));
      }
    }
  }
  const fieldsNode = node(TAGS.SPYFIELDS, "", fields);
  return msg
    ? node(TAGS.SPYBLOCK, "msg", [toExpr(msg), fieldsNode])
    : node(TAGS.SPYBLOCK, "", [fieldsNode]);
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
function lowerPrelude(prelude: CstNode): {
  provideFlag: string;
  provideExpr: AstNode | null;
  imports: AstNode[];
} {
  let provideFlag = "";
  let provideExpr: AstNode | null = null;
  const imports: AstNode[] = [];
  for (const stmt of prelude.kids) {
    if (stmt.name === "provide-stmt") {
      // `provide: a, b end` / `provide from M: ...` -> s-provide-block (check first,
      // since a spec name-spec can itself contain STAR/TIMES).
      const pblock = findFirst(stmt, "provide-block");
      if (pblock) {
        const specs: AstNode[] = [];
        for (const sp of pblock.kids) {
          if (sp.name !== "provide-spec") continue;
          const mref = findFirst(sp, "module-ref");
          specs.push(node(TAGS.PSPEC, mref ? (findFirst(mref, "NAME")?.value ?? "") : ""));
          // TODO(grammar): provide type/data/module specs, `as`, star, `from` source
        }
        provideFlag = "pblock";
        provideExpr = node(TAGS.PROVIDEBLOCK, "", [node(TAGS.PSPECS, "", specs)]);
        continue;
      }
      // `provide *` -> provide-all; `provide { ... } end` -> s-provide of the obj.
      if (findFirst(stmt, "TIMES") || findFirst(stmt, "STAR")) { provideFlag = "all"; continue; }
      const objNode = findFirst(stmt, "obj-expr");
      if (objNode) { provideFlag = "block"; provideExpr = toExpr(objNode); }
      continue; // TODO(grammar): provide-types
    }
    if (stmt.name === "import-stmt") {
      const isInclude = stmt.kids[0]?.name === "INCLUDE";
      // file("path") special import -> s-special-import (as `include` or `import as`).
      const special = findFirst(stmt, "import-special");
      if (special) {
        const strNode = special.kids.find((k) => k.name === "STRING");
        const path = strNode ? stripStr(strNode.value ?? "") : "";
        if (isInclude) {
          imports.push(node(TAGS.INCLUDEFILE, path));
        } else {
          const alias = stmt.kids.find((k) => k.name === "NAME")?.value ?? "";
          imports.push(node(TAGS.IMPORTFILE, path, [node(TAGS.NAMESTR, alias)]));
        }
        continue;
      }
      const srcName = findFirst(stmt, "import-name");
      const modName = srcName ? (findFirst(srcName, "NAME")?.value ?? "") : "";
      if (!modName) continue; // TODO(grammar): include file("..."), import-special include
      if (isInclude) {
        imports.push(node(TAGS.INCLUDE, modName));
      } else {
        // alias = the NAME after `as` (a direct child of import-stmt)
        const alias = stmt.kids.find((k) => k.name === "NAME")?.value ?? modName;
        imports.push(node(TAGS.IMPORT, modName, [node(TAGS.NAMESTR, alias)]));
      }
    }
  }
  return { provideFlag, provideExpr, imports };
}

function flatten(n: AstNode, out: SerNode[]): void {
  out.push({ tag: n.tag, nkids: n.kids.length, str: n.str });
  for (const k of n.kids) flatten(k, out);
}

// Lower a full `program` CST into the flat pre-order SerNode stream.
export function serializeCst(program: CstNode): SerNode[] {
  const prelude = program.kids.find((k) => k.name === "prelude");
  const { provideFlag, provideExpr, imports } = prelude
    ? lowerPrelude(prelude)
    : { provideFlag: "", provideExpr: null, imports: [] };
  const block = program.kids.find((k) => k.name === "block");
  const stmts = block ? block.kids.map(toExpr) : [];
  // PROGRAM normally carries [IMPORTS, BLOCK]; for `provide { ... }` (flag
  // "block") the provide expr is prepended as a leading kid (3 kids total).
  const kids = [
    node(TAGS.IMPORTS, "", imports),
    node(TAGS.BLOCK, "", stmts),
  ];
  if (provideExpr) kids.unshift(provideExpr);
  const root = node(TAGS.PROGRAM, provideFlag, kids);
  const out: SerNode[] = [];
  flatten(root, out);
  return out;
}
