# self-host/ — the Pyret-written compiler (port of the TS seed)

This is the **second** of the three compilers: a faithful **Pyret port of the
TypeScript seed** (`src/compiler/`). The seed compiles this into `compiler.wasm`; the
self-hosting **fixpoint** is `compiler.wasm` compiling its own source to a
byte-identical compiler. It deliberately mirrors the seed 1:1 so the two stay in sync
and debugging later is a side-by-side diff.

> Distinct from: `self-compiler/` (a copy of Pyret's *real* 23k-line front-end, used
> to stress the seed) and `selfhost/` (the older from-scratch toy compiler).

## Files (mirror of `src/compiler/`)
| this | mirrors | status |
|---|---|---|
| `compile.arr` | `compile.ts` | structure ported: CST helpers, the full `compile-expr` dispatch, `compile-app` intrinsic table + closure-call convention, 3-pass `compile-program`; bodies are `TODO(port)` calling the encoder |
| `encoder.arr` | binaryen + `runtime.ts` byte emission | substantive: LEB128, sections, GC types, instruction emitters (i32/i64/f64, struct/array, ref.test/cast/i31, call/return_call_indirect, if/block/loop/br) |
| `runtime.arr` | `runtime.ts` | catalog of all 69 runtime functions (number tower, bignum kernels, strings, variants/objects, equality, rendering, checks, CPS yield); bodies `TODO(port)` |
| `cps.arr` | `cps.ts` | **full** 1:1 port of the Danvy one-pass CPS transform (the third compiler) |

The shared stdlib is `src/compiler/prelude.arr` (one source of truth for all three
compilers) — not redefined here.

## Status & how to finish it
These are **sketches**: they are NOT yet runnable end-to-end (intentionally — built
alongside the TS work to avoid context loss; debug at the end). To bring them up:
1. Wire a `CstNode` provider (reuse the JS parser's output, fed in as data) — or shim
   `parse-pyret` so `compiler.wasm` parses source itself.
2. Fill the `TODO(port)` bodies in `compile.arr`/`runtime.arr` by translating each
   `m.*` binaryen call in `src/compiler/*.ts` to the corresponding `encoder.arr` emitter.
3. Make the seed compile `self-host/compile.arr` (it uses data/cases/lists/strings/
   recursion/maps — a bounded subset the seed already largely handles).
4. Run the fixpoint harness (`scripts/selfhost-fixpoint.ts`, retargeted here).

## Biggest debugging risks (noted during the port)
- Exact **byte encodings** vs binaryen (esp. blocktypes, signed LEB, f64 IEEE bits).
- **GC rec-group / type indices** in `encoder.arr` must match `runtime.arr`’s layout.
- **`return_call_indirect`** type indices for the closure calling convention.
- Value-model **tag bytes** (i31 for booleans/`nothing`) and the number-tower tags.
- `compile-expr` arms that are still `TODO(port)` (most bodies) — port from `compile.ts`
  case-by-case; the dispatch arms are already in place to guide it.
