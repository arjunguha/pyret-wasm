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
- **Source locations are real.** The tokenizer threads a `Pos` (line/column/char,
  lines 1-based, columns + char 0-based, matching Pyret) and every `Token` carries
  its start+end span. The parser tracks the most-recently-consumed token in a
  `var last-tok`; each `parse-*` captures its first token as `start` and builds the
  node loc with `node-loc(start)` = span from `start`'s beginning to `last-tok`'s
  end. `parse-named(src, uri)` records `uri` as the srcloc source name. (A handful
  of deeply-nested *secondary* locs — op-loc on check-ops, pat-loc, the `where`
  loc — are still `dummy-loc`; the primary `l` of every node is real.)
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

## Done since the first pass

- **Full annotation grammar**: name / dot / app (`List<T>`) / arrow (`(A -> B)`) /
  record (`{x :: A}`) / tuple (`{A; B}`) / pred (`Ann%(expr)`) / `Any`.
- **Tuple bindings** `{a; b} [as n]`, and **contract statements** (`x :: T` with no
  `=` desugars to `s-contract`).
- **`type` aliases** (`type T<a> = Ann`) and **`newtype`** (`newtype T as TT`).
- **`~` rough fractions** → `s-rfrac`.
- **Real source locations** (see Design above) — line/col/char + source name.

## Done in round 3

- **`multi-let` / `letrec` / `type-let`** expressions (`let a = 1, b = 2: ... end`,
  `letrec f = ...: ... end`, `type-let T = Ann: ... end` incl. `newtype` binds) →
  `s-let-expr` / `s-letrec` / `s-type-let-expr`.
- **Tuple-destructuring let** at statement position (`{a; b} [as n] = e`), via a
  brace-depth lookahead (`tuple-let-ahead`) that tells `{...} =` (a tuple-let) apart
  from a `{...}` tuple/object expression.
- **`spy`** blocks (`spy [msg]: NAME, NAME: expr end`) → `s-spy-block` with
  implicit-label and explicit `s-spy-expr` fields.
- **Full check-op set**: `is` / `is==` / `is=~` / `is<=>` / `is-not` / `is-not==` /
  `is-not=~` / `is-not<=>` / `is-roughly` / `is-not-roughly` / `raises` /
  `raises-other-than` / `raises-satisfies` / `raises-violates` / `does-not-raise`
  (postfix, no RHS) / `satisfies` / `violates`, plus the `%(refinement)` clause and
  the `because <cause>` clause.  Check-op locs are now **real** (no longer dummy).
- **Exact decimals** (`3.14` → `s-num` holding the exact rational `numer / 10^k`) and
  **rough integers** (`~5` → `s-num` holding a roughnum, no longer an exact int).

## Done in round 4 (parsing REAL compiler source)

Driven by feeding real `self-compiler/**.arr` files through `parse` (via `read-source()`;
see `pyret-parser-realfile-probe.arr` + the `parses real compiler source files` test).
**50 of 76 real compiler/trove files now parse**; the rest are blocked by SCALE, not
grammar (see below). Gaps closed:

- **multi-binding `for`** (`for raw-array-fold(a from x, b from y, _ from z): ...`). The
  iterator is now parsed with `parse-postfix-noapp` (name/dot chain, no trailing app) so the
  `(` opens the for-binds rather than being eaten as an application.
- **triple-backtick strings** `` ```...``` `` (raw, multi-line) — pervasive as `doc:` strings.
- **unary sign on numeric literals** (`-1`, `+2`, `~5` after a sign) in operand position —
  Pyret's `num-expr` carries the sign; there is no general unary minus (`-x` on a non-literal
  isn't valid Pyret).
- **contract statements with ty-params + no-paren arrow anns**:
  `name :: <A> (A -> B), C -> D` (grammar `contract-stmt: NAME COLONCOLON ty-params (ann |
  noparen-arrow-ann)`).  Also typed lets `name :: ann = value` route through the same path.
- **curly-brace lambdas** `{ [ty-params] args [-> ann] : block }` (e.g. `{(k): {k; v}}`);
  blocks now also terminate at `}`.
- **`include from MOD: spec, ... end`** selective includes — bare names, `type`/`data`/
  `module` specs, `* ` and `type *`/`data *`, optional `as`.
- (ty-params on `fun`/`method`/`data` declarations were already supported.)

## Done in round 5 (table literal + the grammar gaps the scale-fix exposed)

Once the SCALE blockers were fixed elsewhere (the parser became constant-stack — tail-
recursive `lex`/`parse-stmts` — and the runtime now auto-grows linear memory for big
sources), the 80–130KB files ran far enough to reveal real grammar gaps that scale had been
masking.  All of these are now closed:

- **`table:` literal** (`table-expr`): `table: hdr [:: ann] (, hdr)* (row: e (, e)*)* end`
  → `s-table(l, List<FieldName>, List<TableRow>)` via `parse-table` & helpers (dispatched
  from `parse-name-atom` when `table` is followed by `:`, mirroring `block:`).  `tables.arr`.
- **Trailing comma in a `with:` block** before the next variant / `sharing:` / `where:` /
  `end` — `parse-fields` now stops a trailing comma at `BAR`/`end`/`sharing`/`where`, not
  just `}`.  This was the dominant gap: `ast.arr`, `lists.arr`, `compile-structs.arr`,
  `checker.arr`, `charts.arr` all hit it.
- **`for` iterator that is an application**: `for f(loc)(b from e, ...): ...` — the iterator
  postfix now consumes app-parens but stops at the for-binds paren, recognized by a
  `from`-lookahead (`forbinds-ahead`/`forbinds-scan`).  `checker.arr`.
- **`{(a + b) - c; d}` parenthesized first tuple item vs `{(args): ...}` lambda** —
  `parse-brace` now looks past the leading `(`'s matching `)` (`after-paren-tok`): it's a
  curly-lambda only if `:` / `->` / `block` follows, else a tuple.  `charts.arr`, `error.arr`.
- Parser errors (`expect`/`expect-name`) now carry `line`/`col`, which made locating all of
  the above fast.

**Status: 83 of 84 real `self-compiler/**.arr` + `self-host/*.arr` files parse.** Every CORE
compiler file parses (ast / lists / compile-structs / checker / anf / desugar / well-formed /
resolve-scope / …).

## COVERAGE: the ENTIRE self-hosted closure parses (96/96)

Every `.arr` in `self-compiler/{compiler,trove}/**` + `self-host/*.arr` (96 files, incl
`compiler/locators/*`) now parses with the pure-Pyret parser — verified by a scan + by
`test/parser-closure.test.ts`.  The last grammar gap (generic instantiation) is CLOSED.

## RESOLVED — generic instantiation (LANGLE-vs-LT)

`name<Ann, ...>(...)` (e.g. `for raw-array-fold2<Number, Number, Number>(acc from ..., ...)`
in `matrices.arr`, and `f<T>(x)` in expression position) now parses to `s-instantiate`.
`<`/`>` lex as comparison OPs, so the disambiguation is a lookahead (`inst-ahead`/`inst-scan`
in pyret-parser.arr): a `<` with NO `ws-before` whose matching `>` is immediately followed by
`(` is a type application; anything else stays an `s-op` comparison.  This shape never matches
a real comparison, so no whitespace-tokenizer change was needed.  Wired into both
`parse-postfix-rest` (expression position → app of the instantiation) and
`parse-postfix-noapp-rest` (the `for` iterator → the following `(` is the for-binds).

## TODO(grammar) — unexercised forms (NOT in the compiler closure)
- The other **table operations** (`select`/`sieve`/`order`/`extract`/`transform`/`extend`/
  `update`/`load-table`) and `reactor` — only `table:` is used by the compiler source.
- **Decimal exponents** (`3.14e5`), full string escapes (`\u`, `\x`, octal) — unexercised;
  pin the exact-vs-rough semantics against the reference parser before implementing.
- Reject mixed operators without parens (defer to well-formedness, as real Pyret).
- The last couple of secondary `dummy-loc`s (pat-loc on cases binds, where-loc).

## (historical) SCALE blocker — RESOLVED

The 80–130KB files used to fail with `Maximum call stack size exceeded` (size-proportional
recursion) and `Length out of range of buffer` (linear-memory limit).  Both are fixed: the
tokenizer/statement loops are tail-recursive (the seed does native tail calls) and the
runtime auto-grows memory.  Original wording kept below for context:
RUNTIME/architecture task (make the tokenizer + statement/list loops iterative / tail-
recursive so they run in constant stack — the seed does native tail calls — and/or raise the
seed's memory/string limits), out of scope for grammar work.  Tracked here as the next step
for the pure-Pyret parser.
- Decimal **exponents** (`3.14e5` — currently the integer part only), full string
  escapes (`\u`, `\x`, octal), triple-backtick strings.
- Generics/instantiation `f<T>(...)` in expression position (`<`/`>` lex as
  comparison ops; needs the LANGLE-vs-LT whitespace distinction the real tokenizer
  makes — genuinely ambiguous for plain recursive descent).
- Reject mixed operators without parens (defer to well-formedness, as real Pyret).
- The last couple of secondary `dummy-loc`s (pat-loc on cases binds, where-loc).

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

## Constant-stack tokenizer/parser (2026-06-27) — large files now parse

The 25 largest real compiler files used to fail with **"Maximum call stack size
exceeded"**: the tokenizer and the statement-list parser recursed proportionally to
file length. Fixed by making the file-length-proportional recursions TAIL-RECURSIVE
(accumulator + a local tail-recursive `rev`; the seed compiles native tail calls, so
these now run in CONSTANT stack):

- `lex` / `lex-punct` — thread a reverse `acc :: List<Token>`; every branch (skip,
  comment, number, rough, name, string, triple-quote, punct, unknown) is now a tail
  call. `tokenize` `rev`s the accumulator to forward order.
- `parse-stmts` — `parse-stmts-acc(st, acc)` accumulates statements in reverse, then
  `rev`s. (A program/block can hold hundreds of top-level statements.)
- Added local `rev`/`rev-onto` because the prelude's `reverse` is itself non-tail AND
  O(n^2) (append-based) — it would overflow / be quadratic on long token lists.

RESULT: previously-overflowing files now parse, e.g. `anf.arr` (452 LOC),
`desugar.arr` (1007), `well-formed.arr` (1410). Tested in
`test/pyret-parser.test.ts` ("large compiler files parse").

REMAINING BLOCKER (NOT stack, NOT grammar): the very largest files —
`resolve-scope.arr` (1874 LOC), `type-check.arr` (2662), `ast.arr` (3739) — now fail
with **"Length out of range of buffer"**, a HOST/MEMORY-sizing limit (linear memory /
the `read-source` source buffer / `$str_to_codepoints`), surfaced in `src/runtime/run.ts`
+ the seed runtime — OUTSIDE pyret-parser.arr (not editable from this lane). Next
follow-up: raise/auto-grow the linear-memory + source-buffer sizing (and/or stream
`string-to-code-points`) so 100KB+ files fit. Until then, deeply NESTED expressions
still recurse by nesting depth (bounded, fine) — only file-length recursion was the
stack issue, and that is resolved.

## Surface gaps closed after the no-JS parser swap (provide-block, bare instantiation, stmt-reactor)
- `provide: spec, ... end` -> s-provide-block (specs incl `*`/`type *`/`data X hiding (...)`/`as`); placed in s-program._provide to match the JS-GLR bridge.
- bare instantiation `f<Number>` (no call) -> s-instantiate (matching `>` followed by EOF/`)`/`]`/`}`/`,`/`:` => instantiation, else comparison).
- `reactor: ... end` at statement position -> s-reactor.
Whole closure still parses; surface-parse.test.ts reactor/f<Number>/provide-block restored.
