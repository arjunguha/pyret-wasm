# Corpus programs the fixpoint compiler is NOT expected to support

The deliverable is the **self-hosted fixpoint compiler** (the Pyret compiler written in
Pyret, compiled by itself) **+ the CPS stopping transform**. It targets the **core Pyret
language**: numbers/strings/booleans, `data` + `cases`, functions/lambdas/closures,
`if`/`ask`/`when`/`for`, `let`/`var`/`rec`, objects + methods, lists, `check`/`where`
(`is`/`is-not`/`is%`/`is-roughly`/`satisfies`/`raises`), and the full number tower.

The following categories of corpus programs are **acceptably out of scope** — they require a
capability the fixpoint compiler is not designed to provide (host IO, the type checker,
charts/reactor, the compiler-as-a-library, networking, RNG, non-core troves). This is a
deliberate decision, not a bug to fix.

Corpus size: **339 `.arr` files** = 164 "behavioral" programs + 175 `type-check/` fixtures.
Counts below are from grep over `test-corpus/`.

| Category | Count | Why unsupported | Examples |
|---|---|---|---|
| **A. Type-checker tests** (`type-check/`) | **175** | The tree's purpose is "does the checker accept/reject this?"; the pipeline does desugar/anf, not type-check enforcement (73 are *meant to fail* type-check). | `bad/a-pred.arr`, `should-not/obj-update.arr` |
| **B. Filesystem / IO / input / timing** | 30 | `read-file`/`filelib`/`run-task`/`IO.prompt`/`cmdline`/`pathlib`/`read-json`/`time-now` — no host IO layer. | `test-file.arr`, `test-json.arr`, `test-input-*-prompt.arr` |
| **E. Compiler-as-a-library / meta** | 30 | Import the real compiler modules (`parse-pyret`/`ast`/`compile-lib`/`repl`/`checker`); the fixpoint compiler isn't exposed as importable Pyret modules. | `test-compile-lib.arr`, `test-repl.arr`, `pyret/main.arr` |
| **C. Tables / CSV** | 14 | `table:`/`load-table`/`table-extend`, `tables`/`data-source`/`csv` libs. | `test-tables.arr`, `test-csv-table.arr` |
| **D. Charts / image / world / reactor** | 13 (~9 behavioral) | Plotting/drawing libs; **`reactor` is explicitly out of scope.** | `test-charts.arr`, `test-images.arr`, `test-reactor.arr` |
| **H. Random / nondeterminism** | 8 | Seeded `random`/`num-random` assertions; no host RNG. | `test-numbers.arr`, `random-bogus-range.arr` |
| **F. Networking / HTTP imports** | 7 | `import url-file("http://…")` remote fetch. | `io-tests/.../test-import-url*.arr` |
| **G. Special module loaders** | 6 | `npm(...)`/`my-gdrive(...)`/`protocol(...)`/`js-file(...)` host resolvers. | `test-npm-import.arr` |
| **I. Non-core troves** | small overlaps | `s-exp` (6), `statistics` (3), `matrices` (2), `spy` (3) — mostly overlap the above. | `test-s-exp.arr`, `test-statistics.arr` |

## Totals

- **~253 / 339 still unsupported** = the 175 `type-check/` fixtures + **78** behavioral files
  needing IO/tables/charts/reactor/compiler-lib/network/RNG/non-core troves.
- **~86 / 339 (~25% of the full corpus; ~52% of the 164 behavioral programs) are
  core-supportable** at the fixpoint — the pure-core programs (e.g. `test-cases`,
  `test-equality`, `test-match`, `test-math`, `test-roughnum`, `test-within`,
  `test-constructors`, `test-string-dict`), most `tests/modules/*` (multi-file
  provide/include), and many `regression/*`.

**The fixpoint compiler's corpus target is therefore the ~86 core-supportable programs**, not
the full 339. The remaining ~253 are out of scope by design.

Caveats: some core-supportable programs are multi-file (assume working separate compilation);
grep matches feature keywords/imports (a few false positives were manually excluded, e.g.
the string `"world"`); and the *current* self-hosted compile count (see
`scripts/SELFHOST-SCOREBOARD.md`) is lower than ~86 because of in-scope work still in progress
— that is "not yet implemented," distinct from the categories above which are "out of scope."
