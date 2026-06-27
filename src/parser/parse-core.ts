// Environment-agnostic CST construction from Pyret's tokenizer + GLR parser.
// Both the Node adapter (pyret-parser.ts) and the browser adapter feed the
// loaded `Tokenizer` and `PyretGrammar` objects in here.

export interface Pos {
  startLine: number;
  startCol: number;
  startChar: number;
  endLine: number;
  endCol: number;
  endChar: number;
}

export interface CstNode {
  name: string;
  value?: string; // present on terminals (Atoms)
  kids: CstNode[]; // empty on terminals
  pos: Pos;
}

export class ParseError extends Error {
  pos?: Pos;
  constructor(message: string, pos?: Pos) {
    super(message);
    this.name = "ParseError";
    this.pos = pos;
  }
}

function srcloc(pos: any): Pos {
  return {
    startLine: pos.startRow,
    startCol: pos.startCol,
    startChar: pos.startChar,
    endLine: pos.endRow,
    endCol: pos.endCol,
    endChar: pos.endChar,
  };
}

function convert(node: any): CstNode {
  if (node.kids === undefined) {
    return { name: node.name, value: node.value, kids: [], pos: srcloc(node.pos) };
  }
  return { name: node.name, kids: node.kids.map(convert), pos: srcloc(node.pos) };
}

// T = the tokenizer module, G = the parser module (exposing PyretGrammar).
export function parseWith(T: any, G: any, src: string): CstNode {
  const toks = T.Tokenizer;
  toks.tokenizeFrom(src);
  const parsed = G.PyretGrammar.parse(toks);
  if (!parsed) {
    const cur = toks.curTok;
    const pos = cur && cur.pos ? srcloc(cur.pos) : undefined;
    throw new ParseError(
      `Parse error${cur ? ` near ${JSON.stringify(cur.value ?? cur.name)}` : ""}`,
      pos,
    );
  }
  const count = G.PyretGrammar.countAllParses(parsed);
  if (count !== 1) {
    const asts = G.PyretGrammar.constructAllParses(parsed);
    return convert(asts[0]);
  }
  return convert(G.PyretGrammar.constructUniqueParse(parsed));
}
