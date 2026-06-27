// Token definitions for the Pyret lexer.
// Faithful to pyret/lang/src/js/base/pyret-tokenizer.js, focused on the
// subset the compiler currently supports (expandable).

export interface SrcLoc {
  startLine: number;
  startCol: number;
  startChar: number;
  endLine: number;
  endCol: number;
  endChar: number;
}

export interface Token {
  name: string; // token kind, e.g. "NAME", "NUMBER", "FUN"
  value: string; // the matched text (for STRING, the unescaped contents)
  loc: SrcLoc;
}

export function locSpan(a: SrcLoc, b: SrcLoc): SrcLoc {
  return {
    startLine: a.startLine,
    startCol: a.startCol,
    startChar: a.startChar,
    endLine: b.endLine,
    endCol: b.endCol,
    endChar: b.endChar,
  };
}

// Word keywords: an alphabetic NAME run that exactly equals one of these
// becomes the corresponding keyword token. Hyphenated keywords (is-not, etc.)
// are matched by the NAME rule since dashes are valid mid-identifier.
export const WORD_KEYWORDS: Record<string, string> = {
  and: "AND",
  as: "AS",
  ascending: "ASCENDING",
  ask: "ASK",
  by: "BY",
  cases: "CASES",
  check: "CHECK",
  data: "DATA",
  descending: "DESCENDING",
  do: "DO",
  "does-not-raise": "RAISESNOT",
  else: "ELSE",
  end: "END",
  examples: "EXAMPLES",
  extend: "TABLE-EXTEND",
  extract: "TABLE-EXTRACT",
  false: "FALSE",
  for: "FOR",
  from: "FROM",
  fun: "FUN",
  hiding: "HIDING",
  if: "IF",
  import: "IMPORT",
  include: "INCLUDE",
  is: "IS",
  "is==": "ISEQUALEQUAL",
  "is=~": "ISEQUALTILDE",
  "is-not": "ISNOT",
  "is-not==": "ISNOTEQUALEQUAL",
  "is-not=~": "ISNOTEQUALTILDE",
  "is-not<=>": "ISNOTSPACESHIP",
  "is-roughly": "ISROUGHLY",
  "is-not-roughly": "ISNOTROUGHLY",
  "is<=>": "ISSPACESHIP",
  because: "BECAUSE",
  lam: "LAM",
  lazy: "LAZY",
  let: "LET",
  letrec: "LETREC",
  "load-table": "LOAD-TABLE",
  method: "METHOD",
  module: "MODULE",
  newtype: "NEWTYPE",
  of: "OF",
  or: "OR",
  provide: "PROVIDE",
  "provide-types": "PROVIDE-TYPES",
  raises: "RAISES",
  "raises-other-than": "RAISESOTHER",
  "raises-satisfies": "RAISESSATISFIES",
  "raises-violates": "RAISESVIOLATES",
  reactor: "REACTOR",
  rec: "REC",
  ref: "REF",
  sanitize: "SANITIZE",
  satisfies: "SATISFIES",
  select: "TABLE-SELECT",
  shadow: "SHADOW",
  sieve: "TABLE-FILTER",
  spy: "SPY",
  order: "TABLE-ORDER",
  transform: "TABLE-UPDATE",
  true: "TRUE",
  type: "TYPE",
  "type-let": "TYPE-LET",
  using: "USING",
  use: "USE",
  var: "VAR",
  violates: "SATISFIESNOT",
  when: "WHEN",
};

// Colon keywords: a NAME run immediately followed by ":" (no space).
export const COLON_KEYWORDS: Record<string, string> = {
  block: "BLOCK",
  check: "CHECKCOLON",
  doc: "DOC",
  else: "ELSECOLON",
  examples: "EXAMPLESCOLON",
  otherwise: "OTHERWISECOLON",
  provide: "PROVIDECOLON",
  row: "ROW",
  sharing: "SHARING",
  source: "SOURCECOLON",
  table: "TABLE",
  then: "THENCOLON",
  where: "WHERE",
  with: "WITH",
};
