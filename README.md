# Pyret on WebAssembly

A from-scratch **WebAssembly compiler and runtime for the Pyret language**, plus a
`code.pyret.org`-style web IDE — all running on `bun` (server/CLI) and in the browser.

The goal is to match Pyret's semantics exactly: the full number tower (exact
arbitrary-precision integers, exact rationals, and IEEE "roughnums" with Pyret's
contagion rules), proper tail calls, Pyret's renowned error messages, and a working
**Stop button** — with the value model and runtime implemented *in WebAssembly* rather
than leaning on `js-numbers.js`. On the web, only the things WASM genuinely can't do
(DOM, editor, canvas, the event loop) live in a thin layer of JavaScript.

---

## Status at a glance

| Capability | State |
|---|---|
| Number tower in WASM (bignum int/rational, roughnum, contagion) | ✅ |
| Proper tail calls (`return_call_indirect`, verified millions deep) | ✅ |
| Data/cases, objects, lists, strings, closures, tuples, `for`, `var`/`:=` | ✅ |
| Pyret-style runtime error messages | ✅ |
| Stop button on the UI thread (no Web Worker), cooperative | ✅ |
| Stoppable codegen (CPS), built-in HOFs (`map`/`each`/`foldl`) interruptible | ✅ |
| Web IDE: editor, REPL, Run/Stop, **images** (incl. remote `image-url`) | ✅ |
| Three-way benchmark vs original Pyret | ✅ |
| Self-hosted compiler in WASM (lexer/parser/codegen in Pyret) | 🚧 demos only |
| Full `code.pyret.org` parity (rich tables, debugger) | 🚧 partial |

Unit/e2e tests: **83 pass / 0 fail**. Pyret's own `.arr` corpus (a health metric,
not the target): ~**133 / 342**.

---

## Repository layout

```
src/                     The compiler + runtime "seed" (TypeScript; see Architecture)
  cli.ts                 `pyretc run file.arr` entry point
  build.ts               buildSource / buildSourceFile: parse → compile → wasm (+ multi-module inlining)
  build-core.ts          parser-agnostic build helper
  build-stoppable.ts     STOPPABLE build: CPS source-to-source, then compile
  build-stoppable-core.ts  parser-agnostic stoppable build (used by the browser bundle)
  parser/
    pyret-parser.ts      wraps Pyret's reused JS tokenizer + generated GLR parser (Node/bun)
    parser-browser.ts    same parser, wired for the browser
    parse-core.ts        the CstNode type the whole compiler consumes
    lexer.ts, tokens.ts  a hand-written TS lexer kept only as reference (NOT on the hot path)
  compiler/
    types.ts             WASM-GC type hierarchy ($Num/$Fixnum/$Rational/$Roughnum/$Bignum,
                         $Str, $Variant, $Closure, $Object, …) built via binaryen TypeBuilder
    runtime.ts           the RUNTIME, emitted as WASM IR: number tower, equality, compare,
                         bignum long division + gcd, string ops, list/variant helpers, value
                         rendering, the CPS yield/resume primitives. ~1.4k lines.
    compile.ts           the codegen: CstNode → WASM (closures via function table +
                         call_indirect; tail calls; intrinsics; cases/data/objects/for). ~1k lines.
    prelude.ts           the standard library WRITTEN IN PYRET (List, Option, map/filter/
                         foldl/range/each/…), compiled by our own backend and prepended.
    cps.ts               the Pyret→Pyret CPS transform (Danvy one-pass), emits Pyret source.
  runtime/
    run.ts               host glue for bun/Node: print, raise (throw), the check-harness
                         reporting, emit-byte, do_pause. The I/O boundary. Minimal.
    run-stoppable.ts     the single-thread trampoline driver (pause/resume/stop).

web/                     The browser IDE (served statically; user code runs on the UI thread)
  index.html             layout + styles
  ide.js                 DOM controller (Run/Stop/REPL, output, wires PyretRunner)
  image.js               canvas renderer for Pyret image values (the JS the canvas needs)
  main.ts → main.bundle.js   bundles the WASM compiler+runtime+driver for the browser
  parser-bundle.js       Pyret's JS parser, AMD-shimmed for the browser (gen-parser-bundle.ts)
  vendor/                CodeMirror + CPO's Pyret mode (codemirror.js/css, pyret-mode.js, …)

scripts/
  serve.ts               static server for the IDE (PORT, HOST env)
  bench.ts               benchmark: direct vs stoppable Pyret→Wasm
  bench-pyret-baseline.sh benchmark: original Pyret (rebuilds + times standalones)
  ide-test.ts            headless-Chrome smoke test of the IDE (puppeteer-core)
  run-corpus.ts          runs Pyret's own .arr test corpus as a scoreboard
  gen-parser-bundle.ts   generates web/parser-bundle.js

selfhost/                27 Pyret programs that emit WASM bytes — the self-hosting evidence
                         (a compiler-in-Pyret: numbers, closures, data/cases, bignums, a WASM
                         binary encoder — all written in Pyret, compiled by the seed, run to
                         produce runnable .wasm). The path toward retiring the TS seed.
examples/                small standalone .arr programs
test/                    e2e.test.ts, runtime.test.ts, stoppable.test.ts, image.test.ts
pyret/                   the upstream Pyret language (brownplt/pyret-lang) — reused parser,
                         .arr passes, the pitometer benchmark suite, and the baseline compiler
ROADMAP.md               detailed design notes + progress log
```

---

## Building and running

**Prerequisites:** [`bun`](https://bun.sh) (tested with 1.3.14). For the original-Pyret
baseline only, you also need Node (see below); install via `nvm`.

```bash
bun install
```

### Run a program on the CLI (bun)

```bash
bun run src/cli.ts run examples/frac.arr     # or: bun run pyretc run <file.arr>
PYRET_DUMP=1 bun run pyretc run <file.arr>    # also dump the generated .wat
```

### Web IDE

```bash
bun run build:web                 # gen parser bundle + bundle web/main.ts → main.bundle.js
PORT=7000 HOST=0.0.0.0 bun scripts/serve.ts   # then open http://localhost:7000
```

The IDE runs your code **on the UI thread** (no Web Worker). Try Run/Stop (an infinite
loop is interruptible), the REPL, and images, e.g.
`above(beside(circle(40, "solid", "red"), square(60, "solid", "blue")),
image-url("https://.../photo.jpg"))`.

### Original Pyret (benchmark baseline)

The checked-in `pyret/lang/build/phase0/pyret.jarr` is a **stale bootstrap** (out of
sync with `src/arr`), so it must be rebuilt once from current source:

```bash
# 1. Node via nvm (bun can drive the bootstrap compile, but cannot RUN the standalone —
#    it rejects the standalone's duplicate `_` params, which Node allows).
nvm install --lts                 # → ~/.nvm/versions/node/v24.*/bin/node
cd pyret/lang
npm install --no-save --ignore-scripts ws        # runtime dep the standalone needs
bunx browserify src/js/trove/require-node-compile-dependencies.js \
  -o build/phaseA/bundled-node-compile-deps.js
cp build/phase0/js/pyret-parser.js build/phaseA/js/
bun build/phase0/pyret.jarr --outfile build/phaseA/pyret.jarr \
  --build-runnable src/arr/compiler/pyret.arr \
  --builtin-js-dir src/js/trove/ --builtin-arr-dir src/arr/trove/ \
  --compiled-dir build/phaseA/compiled/ \
  --deps-file build/phaseA/bundled-node-compile-deps.js -no-check-mode \
  --require-config src/scripts/standalone-configA.json
# 2. run a program
node build/phaseA/pyret.jarr --run some.arr        # use print(...) to see a value
```

---

## Architecture: the bootstrapped compiler

```
Pyret source
   │  (1) PARSE        Pyret's own JS tokenizer + generated GLR parser  →  CST   [JavaScript]
   ▼
  CST (CstNode tree)
   │  (1b) optional: CPS source-to-source transform (cps.ts) for the Stop button  [JavaScript, for now]
   ▼
   │  (2) CODEGEN      compile.ts walks the CST, emits WASM via binaryen          [JavaScript "seed"]
   ▼
  .wasm module  =  generated program code  +  the runtime (runtime.ts)  +  the
                   Pyret-written stdlib (prelude.ts), all compiled by our backend [WebAssembly]
   │  (3) RUN          WebAssembly.instantiate; call `main`; host imports do I/O   [WASM executes; JS is the I/O boundary]
   ▼
  output / values / images
```

### The bootstrap chain (why "bootstrapped")

The TypeScript in `src/` is the **seed compiler**. It is *kept* (it stays the
bootstrap, and a fallback for syntax the self-hosted compiler doesn't yet handle). Its
job is to compile a compiler *written in Pyret* down to `compiler.wasm`. The headline
goal is to get that **self-hosted compiler working to the point where the CLI, the IDE,
and the test cases actually use it** (with the seed retained underneath). The
`selfhost/` directory holds the working foundation: real Pyret programs — a WASM binary
encoder and code generators for arithmetic, closures, `data`/`cases`, and bignums — that
the seed compiles and runs to emit runnable `.wasm`. Growing that into a compiler that
drives CLI/IDE/tests is the main thrust of ongoing work.

### What is in JavaScript vs WebAssembly

This is the crux of the design, so it's worth stating precisely.

**In WebAssembly (everything that runs your program):**
- The **value model**: numbers (exact `$Fixnum`/`$Bignum` integers, `$Rational`,
  IEEE `$Roughnum`), strings, booleans, `nothing`, closures, `data` variants, objects,
  tuples, lists — all WASM-GC structs/arrays.
- The **runtime** (`runtime.ts`, emitted as WASM): arithmetic with type dispatch and
  contagion, equality/compare, gcd + rational reduction, **bignum long division**,
  string operations, value rendering, and the CPS yield/resume primitives.
- **All compiled user code** *and* the **standard library** (`prelude.ts`), which is
  written in Pyret and compiled by our own backend — so even `map`/`filter`/`foldl`
  are WASM.
- **Proper tail calls** (`return_call_indirect`) and **error unwinding** (a raised
  error throws a JS value that unwinds natively through WASM frames — we deliberately
  avoid the WASM exception-handling proposal).

**In JavaScript (the seed + the irreducible glue):**
- The **compiler itself** (`src/compiler`, `src/parser`) — the throwaway *seed* that
  produces the WASM. (Self-hosting moves this into WASM too.)
- The **parser**: Pyret's own JS tokenizer + generated GLR parser, reused unmodified.
- The **I/O boundary** (`run.ts`): `print`, `raise` (throw), the check-harness
  reporting, `emit-byte`, and `do_pause` (throws the pause signal). A few dozen lines.
- The **stop-button driver** (`run-stoppable.ts`): catches the pause signal, yields to
  the event loop so a Stop click can be serviced on the same thread, then calls the
  exported `resume` — or aborts. This genuinely needs JS (the event loop).
- The **web shell**: CodeMirror editor, the canvas image renderer (`image.js`), and
  DOM wiring (`ide.js`). Canvas/DOM/editor are inherently JS.

### The Stop button (stoppable codegen)

The IDE runs user code on the UI thread, so the Stop button can't `worker.terminate()`.
Instead, a **Pyret→Pyret CPS transform** (`cps.ts`) is composed *before* the untouched
main compiler. It turns the program into continuation-passing style and inserts a
`yield-check` at the top of every function. Periodically the running code returns to a
tiny JS trampoline (`run-stoppable.ts`), which yields to the event loop (so a Stop click
runs and sets a flag) and then resumes via the captured continuation — or, if Stop was
pressed, simply doesn't resume. Because our compiler emits **native proper tail calls**,
CPS's pervasive tail calls don't grow the stack, so the overhead is tiny (≈1.1×) — far
less than Stopify-style JS trampolining (2–10×). The Pyret-written stdlib is CPS'd too,
so built-in higher-order functions are interruptible; primitives (bignum ops) are not
instrumented, since they're bounded.

### Engine baseline

Targets **WASM-GC + tail calls** only — universal in current browsers since Safari 18.2
(Dec 2024) and present in bun/JSC. No other engine proposals are required.

---

## Benchmarks

Three configurations, on Pyret's own `pitometer` programs
(`pyret/lang/pitometer/programs/`). All numbers were taken on this machine; treat them
as relative, not absolute.

### Runtime configuration per config

| Config | What runs | Harness | Timing |
|---|---|---|---|
| **direct Pyret→Wasm** | `buildSourceFile` (Pyret→CST→binaryen→wasm), then `WebAssembly.instantiate` + call `main` | `bun scripts/bench.ts` on **bun 1.3.14** | best of 5; "run" includes instantiation |
| **stoppable Pyret→Wasm** | same, but `buildStoppableSourceFile` (CPS source-to-source first) run through `runStoppable` with `noYield:true` (raw throughput; still interruptible) | `bun scripts/bench.ts` on **bun 1.3.14** | best of 5 |
| **original Pyret** | a rebuilt `phaseA` standalone (`--build-runnable`), executed as `NODE_PATH=pyret/lang/node_modules node out.js` | `bash scripts/bench-pyret-baseline.sh` on **Node v24.18.0** | best of 3; total wall-clock includes ~170 ms Node+runtime startup, so "compute" = total − a `print(1)` baseline |

### Results

| program | original Pyret (compute / total) | direct Pyret→Wasm (run) | stoppable Pyret→Wasm (run) |
|---|---|---|---|
| `adding-ones-2000` | ~5 ms / 175 ms | 1.6 ms | 1.5 ms |
| `recursion-triangle-20000` | ~12 ms / 182 ms | **stack overflow** | 4.5 ms |
| `tail-sum-1000000` | ~78 ms / 248 ms | 122 ms | 137 ms |

Reproduce: `bun scripts/bench.ts 5` and `bash scripts/bench-pyret-baseline.sh`.

### Takeaways (honest)

- **Stoppability is nearly free (~1.1×)** — native WASM tail calls mean the CPS form
  doesn't trampoline.
- **CPS *enables* deep non-tail recursion** (`recursion-triangle-20000`) that overflows
  the direct path's native stack; original Pyret survives the same case via its own
  Stopify trampoline.
- Our WASM **beats original Pyret on the short programs**.
- Original Pyret **wins `tail-sum`** (~78 ms vs 122 ms): `js-numbers` keeps sums under
  2⁵³ *unboxed*, while our runtime allocates a `$Fixnum` every step. That's a concrete
  optimization target (see Next steps).

---

## Testing & results

### Unit / end-to-end (`bun test ./test`) — **83 pass / 0 fail**

| Suite | Tests | Covers |
|---|---|---|
| `test/e2e.test.ts` | 64 | full pipeline: arithmetic/number tower, strings, data/cases, objects, lists, closures, tail calls, error messages, `check` blocks, multi-module, and every `selfhost/` Pyret→WASM demo (incl. real pitometer programs) |
| `test/stoppable.test.ts` | 9 | the CPS pipeline preserves semantics (results match the direct path) and the Stop button interrupts an infinite loop / a built-in `each` on a single thread |
| `test/runtime.test.ts` | 7 | the WASM number tower directly (add/sub/mul/divide, equality, compare, rendering) |
| `test/image.test.ts` | 3 | the image library (constructors, `image-width`/`-height`, scene-graph serialization) |

### How the code is tested

- **Output comparison.** e2e/stoppable tests compile a Pyret string to WASM, run it via
  `run.ts`/`run-stoppable.ts`, and assert on the captured output (e.g.
  `tail-sum-1000000` → `500000500000`). Stoppable tests additionally assert the CPS
  result equals the direct-compiler result, and that a stop request terminates an
  otherwise-infinite computation (`stopped: true`).
- **Self-hosting demos.** The `selfhost/*.arr` programs are compiled by the seed and run
  to emit `.wasm` bytes, exercising the "compiler written in Pyret" path end to end.
- **Headless browser** (`PORT=8099 bun scripts/serve.ts` then
  `PORT=8099 bun scripts/ide-test.ts`, driving real Chrome via puppeteer-core) — **8/8
  checks pass**: runtime ready on the UI thread, `fact(20)` bignum, a `check` summary,
  CodeMirror mounted, REPL evaluates in context, `circle` → 100×100 canvas, `overlay`
  composite → 100×80 canvas, and **Stop interrupts an infinite loop on the UI thread**.
  Remote `image-url` was verified to draw a cross-origin photo at its natural size
  (115×150) — the canvas becomes "tainted", which proves the image actually drew.
- **Corpus scoreboard** (`bun scripts/run-corpus.ts pyret/lang/tests`): runs Pyret's own
  `.arr` tests one subprocess each with a timeout. Currently ~**133/342**. This is a
  *health metric* to track progress, not the success criterion — the self-hosted
  compiler is what must eventually pass the full suite.
- **Benchmarks** as described above.

> Note: run tests with `bun test ./test` (not bare `bun test`, which would also pick up
> upstream Pyret's own JS tests under `pyret/`).

---

## Next steps

Concrete directions for continued work:

1. **Unboxed-number fast path.** Add an unboxed-`i64` representation (or fast path) for
   integers that fit, so we stop allocating a `$Fixnum` per arithmetic step. This is the
   one place original Pyret currently beats us (`tail-sum`), and it should close most of
   that gap.
2. **Get the self-hosted compiler into the loop (current goal).** Build up the in-Pyret
   compiler (compiled to WASM by the seed) until the **CLI, IDE, and test suite actually
   use it** for the programs it supports — with the **seed kept** as bootstrap and as a
   fallback for not-yet-supported syntax. The `selfhost/` demos are the foundation. The
   aim is a real, integrated WASM compiler path, grown incrementally — not a big-bang
   replacement of the seed.
3. **Shrink the JavaScript glue.** Audit and trim `web/main.bundle.js` (~21 MB, mostly
   bundled binaryen + the parser) toward the "minimal JS" goal — e.g. lazy-load or drop
   binaryen at runtime once self-hosting lands, tree-shake, and split the parser out.
4. **Rich rendering + a debugger.** Add `code.pyret.org`-style structured rendering for
   values and tables in the Interactions pane, and a step/breakpoint **debugger** — the
   CPS pause/resume infrastructure already built for the Stop button is most of the
   mechanism needed.
```
