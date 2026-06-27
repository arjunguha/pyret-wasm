// CST -> simplified-AST serialization for the self-hosted parser (Option B in
// self-host/parser-plan.md). The seed's JS GLR parser produces a CST; here we
// lower it to a FLAT pre-order array of tagged nodes that the Pyret side
// (self-host/parse-from-tree.arr) reconstructs into real ast.arr AST values via
// the `parse-*` intrinsics (host imports in run.ts read this array).
//
// Only a type import of CstNode is used, so this module is safe to pull into the
// browser bundle (the type is erased at build time).
import type { CstNode } from "../parser/parse-core.ts";

// Tag codes shared with self-host/parse-from-tree.arr. Keep in sync on both sides.
export const TAGS = {
  PROGRAM: 0,
  BLOCK: 1,
  NUM: 2,
  STR: 3,
  BOOL: 4,
  ID: 5,
  OP: 6,
} as const;

// One node of the flat pre-order stream. `nkids` children follow immediately
// (also pre-order). `str` carries the leaf payload (number text, string value,
// "true"/"false", identifier name, or "op+"-style operator); unused -> "".
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

function stripStr(v: string): string {
  if (v.startsWith("```") && v.endsWith("```")) return v.slice(3, -3);
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'")) return v.slice(1, -1);
  return v;
}

const LEAF = new Set(["num-expr", "string-expr", "bool-expr", "id-expr", "binop-expr"]);

// Descend through single-child wrapper CST nodes (stmt, check-test, expr,
// prim-expr, paren-expr, …) until reaching a node we know how to lower.
function descend(node: CstNode): CstNode {
  let n = node;
  while (!LEAF.has(n.name) && n.kids.length >= 1) n = n.kids[0]!;
  return n;
}

function toExpr(node: CstNode): AstNode {
  const n = descend(node);
  switch (n.name) {
    case "num-expr":
      return { tag: TAGS.NUM, str: n.kids[0]!.value ?? "0", kids: [] };
    case "string-expr":
      return { tag: TAGS.STR, str: stripStr(n.kids[0]!.value ?? ""), kids: [] };
    case "bool-expr":
      return { tag: TAGS.BOOL, str: n.kids[0]!.name === "TRUE" ? "true" : "false", kids: [] };
    case "id-expr":
      return { tag: TAGS.ID, str: n.kids[0]!.value ?? "", kids: [] };
    case "binop-expr": {
      // kids: expr (binop expr)* — left-associative fold.
      if (n.kids.length === 1) return toExpr(n.kids[0]!);
      let acc = toExpr(n.kids[0]!);
      for (let i = 1; i + 1 < n.kids.length; i += 2) {
        const opTok = n.kids[i]!.kids[0]!; // the operator terminal inside `binop`
        const op = "op" + (opTok.value ?? "?");
        acc = { tag: TAGS.OP, str: op, kids: [acc, toExpr(n.kids[i + 1]!)] };
      }
      return acc;
    }
    default:
      throw new Error(`parse-bridge: unhandled CST node '${n.name}'`);
  }
}

function flatten(node: AstNode, out: SerNode[]): void {
  out.push({ tag: node.tag, nkids: node.kids.length, str: node.str });
  for (const k of node.kids) flatten(k, out);
}

// Lower a full `program` CST into the flat pre-order SerNode stream.
export function serializeCst(program: CstNode): SerNode[] {
  const block = program.kids.find((k) => k.name === "block");
  const stmts = block ? block.kids.map(toExpr) : [];
  const root: AstNode = {
    tag: TAGS.PROGRAM,
    str: "",
    kids: [{ tag: TAGS.BLOCK, str: "", kids: stmts }],
  };
  const out: SerNode[] = [];
  flatten(root, out);
  return out;
}
