# Self-hosted compiler scoreboard

Run: `bun scripts/selfhost-corpus.ts test-corpus` (default root `test-corpus/pyret/tests`;
`--limit N`, `--show-self-ok`). Measures **compile** success (bounded) for the SEED vs the
**self-hosted** compiler (`src/build-selfhosted.ts` → `self-host/compile-driver.arr`), plus a
breakdown of self-hosted failure reasons.

## Latest (2026-06-27, full `test-corpus`, 339 files)

| compiler | compiles | % |
|---|---|---|
| seed | 212 | 62.5% |
| **self-hosted** | **34** | **10.0%** |

### Top self-hosted blockers (what to implement next, by frequency)

Two layers gate the self-hosted path: the JS-GLR **surface-parse bridge**
(`src/runtime/parse-bridge.ts` + `self-host/parse-from-tree.arr`) which doesn't yet serialize
several CST nodes, and the driver's **hand-written desugar/anf** (`self-host/compile-driver.arr`
+ `self-host/wasm-of-pyret.arr`).

| count | reason | layer |
|---|---|---|
| 111 | `parse-bridge: unhandled CST node 'check-expr'` | parse bridge |
| 60 | `s-let should have been desugared already` | driver desugar |
| 42 | `Missed case in anf: s-data` | driver/anf (data decls) |
| 14 | `Empty block` | driver |
| 13 | `parse-bridge: unhandled 'type-expr'` | parse bridge |
| 11 | `parse-bridge: unhandled 'inst-expr'` | parse bridge |
| 10 | `parse-bridge: unhandled 'assign-expr'` | parse bridge |
| 6 | `parse error` | parse |
| 6 | `parse-bridge: unhandled 'update-expr'` | parse bridge |
| 4 | `parse-bridge: unhandled 'table-expr'` | parse bridge |
| 3 | `Missed case in anf: s-cases` | driver/anf |
| 2 each | `load-table-expr`, `rec-expr`, `extend-expr`, `reactor-expr`, `letrec-expr`, `PERCENT`; `Missed case in anf: s-construct`; `wasm trap`; `undefined is not an object` | mixed |
| 1 each | `contract-stmt`, `tuple-get`, `newtype-expr`, `get-bang-expr`; `Unknown op: op<>` | mixed |

### Highest-leverage next lanes
1. **`check-expr` in the parse bridge** (111) — by far the biggest single win; the corpus is
   check-heavy. Add `check-expr`/`check-test` to `parse-bridge.ts` TAGS+lowering and
   `parse-from-tree.arr` build-node (→ `s-check`/`s-check-test`).
2. **driver desugar of `s-let`** (60) — the hand-written desugar leaves `s-let` that anf
   rejects ("should have been desugared already"); desugar lets to letrec/the anf-expected form.
3. **`s-data` through the driver→anf→backend** (42) — data declarations.
4. A cluster of small parse-bridge CST nodes (`type-expr`, `inst-expr`, `assign-expr`,
   `update-expr`, …) — each cheap, additive.

NOTE: teaching the seed to emit `_match` (see `selfhost-no-visitor` memory) would let the
driver call Pyret's REAL desugar/anf visitors instead of the hand-written pass — collapsing
the desugar/anf blockers (#2, #3, s-cases, …) at once.
