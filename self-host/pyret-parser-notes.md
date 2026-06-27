# Pure-Pyret Pyret parser — notes & roadmap

`self-host/pyret-parser.arr` is a hand-rolled **tokenizer + recursive-descent
parser** written entirely in Pyret (no JavaScript). It turns Pyret source text
into the `ast.arr` AST — the same AST the real Pyret front-end (desugar / resolve
/ anf / wasm-of-pyret) consumes. It is the eventual replacement for the temporary
JS GLR parser the self-hosted compiler currently depends on; the self-hosting
goal requires that the in-Pyret compiler parse Pyret *in Pyret*.

References mirrored:
- grammar: `pyret/lang/src/js/base/pyret-grammar.bnf`
- tokenizer: `pyret/lang/src/js/base/pyret-tokenizer.js`
- AST constructors: `self-compiler/trove/ast.arr`

## Design

- **Tokenizer** (`tokenize` / `lex` / `lex-punct`) runs over a `List<Number>` of
  code points (via the runtime's `string-to-code-points`). Each `Token` carries a
  `ws-before` flag — set whenever whitespace/comment/newline preceded the token —
  which is what lets `f(x)` (application: `(` with no space) be told apart from
  `f (x)` / `(a + b)` (grouping: `(` with a space). This mirrors the real
  tokenizer's `PARENSPACE`/`PARENNOSPACE` distinction without two paren tokens.
- **Parser state** is a single top-level `var tok-stream :: List<Token>`; every
  `parse-*` function takes a `PState` handle and advances the cursor. (We use a
  top-level var rather than a mutable record field because the seed compiler does
  not yet support ref-field reads / `get-bang`.) Parsing is therefore single-shot
  — one `parse` call at a time, which is all we need.
- **No operator precedence**: like real Pyret, `binop-expr` is parsed
  left-associative; mixing operators without parens is a *well-formedness* error
  enforced later in the pipeline, not at parse time.

## Coverage today (a START, not the whole grammar)

Tokenizer: integers, fractions `a/b`, decimals (best-effort: integer part for
now), `~rough` numbers, `"..."`/`'...'` strings with common escapes, identifiers
with internal dashes, line (`#`) and block (`#| |#`) comments, and all the
operators/punctuation the core needs.

Parser:
- program + prelude: `import X as N`, `import special("...") as N`, `include X`,
  `provide */...`, `provide-types *`, `use` (parsed, partially modeled).
- definitions: `fun`, `data` (variants with members / `ref` / singletons /
  `with:` / `sharing:` / `where:`), `var`, `rec`, `let` bindings, `:=` assign.
- expressions: `lam`, `method`, `if`/`else if`/`else`, `ask`, `cases`, `when`,
  `for`, `block:` user blocks, application, `.field`, method-call chains,
  `!field` get-bang, `.{...}` extend, `!{...}` update, `.{N}` tuple-get,
  `[list: ...]` constructs, `{obj}` / `{tuple; ...}`, literals, `...` template.
- check: `check:`/`examples:` blocks and `lhs is/is-not/is==/raises/satisfies rhs`.
- bindings: `[shadow] NAME [:: ann]`; annotations: name / dot only.

## TODO(grammar) — to reach the full grammar

- Annotations: arrow / record / app (`List<T>`) / pred (`%(...)`) / tuple anns.
- Tuple bindings `{a; b}`, `as` bindings, contract statements (`x :: T`).
- `type` / `newtype` / `type-let` / `multi-let` / `letrec` expressions.
- `spy`, tables (`table:`/`select`/`sieve`/`order`/`extract`/`transform`/
  `extend`/`load-table`), `reactor`.
- Full check-op set (`is=~`, `is<=>`, `is-roughly`, `raises-satisfies`,
  `because`, refinements `%(...)`).
- Real number literals (decimals/exponents → exact rationals; `~` roughnums),
  full string escapes (`\u`, `\x`, octal), triple-backtick strings.
- Generics/instantiation `f<T>(...)` (currently `<`/`>` are only comparison ops).
- Reject mixed operators without parens (defer to well-formedness, as real Pyret).
- **Real source locations** instead of `dummy-loc` (track line/col/pos in the
  tokenizer and thread `Srcloc` through — needed for good error messages and for
  byte-identical fixpoint parity with the reference parser's locs).

## Testing

- `test/pyret-parser.test.ts`: asserts the parser compiles clean under the seed
  (→ valid `\0asm`), plus a tripwire for the end-to-end path.
- The end-to-end path (`pyret-parser-probe.arr`: source → AST) is currently gated
  by the front-end module-init null-ref that affects EVERY program importing
  `ast.arr` in the seed today (fixed in a separate runtime lane). When that
  lands, flip the tripwire into the real assertion (`"s-fun s-app"`).
- Cross-checking against the reference parser: the original Pyret in `../pyret`
  can parse the same sources (`pyret/lang`) so the produced AST shapes can be
  compared `tosource()`-to-`tosource()` as coverage grows.
