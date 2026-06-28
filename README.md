# Pyret on WebAssembly

A from-scratch **WebAssembly compiler and runtime for the Pyret language**, plus a
`code.pyret.org`-style web IDE — all running on `bun` (server/CLI) and in the browser.

The goal is to match Pyret's semantics exactly: the full number tower (exact
arbitrary-precision integers, exact rationals, and IEEE "roughnums" with Pyret's
contagion rules), proper tail calls, Pyret's renowned error messages, and a working
**Stop button** — with the value model and runtime implemented *in WebAssembly* rather
than leaning on `js-numbers.js`. On the web, only the things WASM genuinely can't do
(DOM, editor, canvas, the event loop) live in a thin layer of JavaScript.

The headline ambition — a **self-hosting compiler** — is achieved: a Pyret compiler
*written in Pyret*, compiled to WebAssembly by a TypeScript "seed", reaching a **fixpoint**
where the compiler compiles its own source to a byte-identical module
(`bun scripts/fixpoint-bytecompare.ts`; compiler5 === compiler4).

---

## The three compilers

This repo contains three cooperating compilers (a deliberate design, not redundancy):

1. **The seed** — written in **TypeScript** (`src/`), Pyret → WASM via
   [`binaryen`](https://github.com/WebAssembly/binaryen). It is the bootstrap and is
   *kept* (build-time only). Its job is to compile the other compilers — which are written
   in Pyret — down to WebAssembly.

2. **The self-hosted compiler** — written in **Pyret** (`self-host/` + a copy of Pyret's
   real front-end in `self-compiler/`), the actual deliverable. It compiles Pyret → WASM
   with **no JavaScript in the codegen path**:
   `source → parse → CPS stoppability → desugar → ANF → wasm-of-pyret → (Pyret-written
   WASM encoder + runtime) → runnable module`. **The fixpoint is achieved**: the compiler,
   compiled by itself, produces byte-identical output across successive generations
   (`bun scripts/fixpoint-bytecompare.ts`).

3. **The CPS transform** — an **ast → ast** pass (`self-host/cps-ast.arr`) that makes
   programs cooperatively stoppable (the IDE's Stop button), composed *before* the normal
   compiler. The self-hosted backend lowers the CPS intrinsics (`yield-check` /
   `finish-result` / `cps-op-*`) and exports `resume` — stoppability lives entirely in
   the Pyret-written backend with no stop logic in the seed.

There are likewise **two parsers**: a temporary JavaScript GLR parser (Pyret's own,
reused) kept as a seed-side crutch, and the permanent **pure-Pyret parser**
(`self-host/pyret-parser.arr`, no JS) that already parses 83 of 84 real compiler/library
files and is the only parser the web IDE uses.

---

## Status at a glance

| Capability | State |
|---|---|
| Number tower in WASM (bignum int/rational, roughnum, contagion) | ✅ |
| Proper tail calls (`return_call_indirect`, verified millions deep) | ✅ |
| Data/cases, objects, lists, strings, closures, tuples, `for`, `var`/`:=` | ✅ |
| Pyret-style runtime error messages | ✅ |
| Stop button on the UI thread (no Web Worker), cooperative | ✅ |
| CPS stoppable transform **in Pyret**; built-in HOFs (`map`/`each`/`foldl`) interruptible | ✅ |
| Web IDE: editor, REPL, Run/Stop, **images** (incl. remote `image-url`) | ✅ |
| Seed compiles Pyret's **real ~23K-line front-end** to WASM | ✅ |
| Self-hosted compiler: **end-to-end source → runnable WASM, no JS codegen** | ✅ |
| Pure-Pyret parser (no JS), parses real compiler source | ✅ 83/84 files |
| **Self-hosting fixpoint** (compiler recompiles itself, byte-identical) | ✅ achieved |
| Web IDE: single WASM artifact, pure-Pyret parser, CPS stoppability | ✅ |

Unit/e2e tests: **~437 pass / 0 fail** (`bun test ./test`). Pyret's own `.arr` corpus is
tracked as a *health metric*, not the target.

---

## Repository layout

```
src/                     The SEED compiler + runtime (TypeScript)
  cli.ts                 `pyretc run [--self-hosted] <file.arr>` entry point
  build.ts               buildSource / buildSourceFile: parse → compile → wasm (+ multi-module inlining)
  build-core.ts          parser-agnostic build helper
  build-stoppable.ts     STOPPABLE build: run the Pyret CPS transform, then seed-compile
  build-stoppable-core.ts  parser-agnostic stoppable build
  build-selfhost.ts      drive the old selfhost/ toy compiler (used by selfhost.test.ts / dual-run)
  build-selfhosted.ts    drive the REAL self-hosted compiler (self-host/compile-driver.arr);
                         used by the CLI's --self-hosted and the fixpoint script
  parser/
    pyret-parser.ts      wraps Pyret's reused JS tokenizer + generated GLR parser (Node/bun)
    parse-core.ts        the CstNode type the seed consumes
    lexer.ts, tokens.ts  a hand-written TS lexer kept only as reference (NOT on the hot path)
  compiler/
    types.ts             WASM-GC type hierarchy ($Num/$Fixnum/$Rational/$Roughnum/$Bignum,
                         $Str, $Variant, $Closure, $Object, …) built via binaryen TypeBuilder
    runtime.ts           the seed RUNTIME, emitted as WASM IR: number tower, equality, compare,
                         bignum long division + gcd, string ops, value rendering, the CPS
                         yield/resume primitives.
    compile.ts           the seed codegen: CstNode → WASM (closures via function table +
                         call_indirect; tail calls; intrinsics; cases/data/objects/for;
                         program-order name resolution across merged modules).
    prelude.arr          the standard library WRITTEN IN PYRET (List, Option, map/filter/
                         foldl/range/each/…) — SHARED by all compilers.
    prelude.ts           imports prelude.arr as text (so it bundles for the browser).
  runtime/
    run.ts               host glue for bun/Node: print, raise (throw), check-harness reporting,
                         emit-byte, do_pause, the JS-GLR parse bridge. The I/O boundary.
    run-stoppable.ts     the single-thread trampoline driver (pause/resume/stop).
    parse-bridge.ts      lowers a JS-GLR CstNode → a flat tagged array the Pyret side rebuilds

self-host/               The SELF-HOSTED compiler + CPS transform, WRITTEN IN PYRET
  cps-compile-driver.arr SINGLE compile path the web IDE uses: source → pure-Pyret parser
                         → cps-ast CPS transform → desugar → ANF → wasm-of-pyret → bytes
  compile-driver.arr     non-stoppable variant driver (same pipeline, no CPS inserted)
  wasm-of-pyret.arr      the ANF → WASM-GC backend (replaces Pyret's js-of-pyret);
                         lowers CPS intrinsics yield-check/finish-result/cps-op-*/resume
  encoder.arr            a WASM-GC binary encoder in Pyret (binaryen's role, in Pyret)
  runtime.arr            the runtime emitter in Pyret (number tower, renderer, check harness,
                         $gas/$paused-thunk/$result globals + GAS-RESET for the Stop button)
  pyret-parser.arr       the PURE-PYRET parser (tokenizer + recursive descent, no JS);
                         parses 83 of 84 real compiler/library files; the only parser the
                         web IDE uses
  parse-from-tree.arr    rebuilds ast.arr nodes from the JS-GLR bridge (seed/CLI crutch path)
  cps-ast.arr            the ast→ast CPS stoppable transform (no string emission/re-parse)
  cps-ast-driver.arr     driver for cps-ast (test/bootstrap shim)
  cps.arr                OLDER string-emitting CPS transform (seed's stoppable build path;
                         being superseded by cps-ast.arr for the self-hosted path)
  *-notes.md             coverage/plan notes (parser, namespace)

self-compiler/           A COPY of Pyret's real in-Pyret compiler, reused + modifiable
  compiler/              desugar, resolve-scope, anf, well-formed, type-check, ast-anf, … (29 files)
  trove/                 ast.arr, the stdlib troves the front-end imports (47 files)

web/                     The browser IDE (served statically; user code runs on the UI thread)
  index.html  ide.js  image.js  table.js  main.ts → main.bundle.js  vendor/ (CodeMirror + Pyret mode)
  cps-compile-driver.wasm  the single compiler artifact (built by `bun run build:web`);
                         pure-Pyret parser + CPS transform + self-hosted backend, seed-compiled

scripts/
  serve.ts               static server for the IDE (PORT, HOST env)
  bench.ts               benchmark: seed Pyret→Wasm on the pitometer programs
  bench-pyret-baseline.sh benchmark: original Pyret (rebuilds + times standalones)
  ide-test.ts            headless-Chrome smoke test of the IDE (puppeteer-core)
  run-corpus.ts          runs Pyret's own .arr test corpus as a scoreboard
  selfhost-fixpoint.ts   old fixpoint meter (iterates compile-driver.arr generations)
  fixpoint-bytecompare.ts  the fixpoint gate: iterates until two consecutive generations
                         are byte-identical; reports FIXPOINT ✅ when converged
  gen-cps-compile-driver.ts  builds web/cps-compile-driver.wasm (the web IDE's single artifact)
  gen-merged-compiler.ts  reports stats on the merged whole-compiler source

selfhost/                EARLIER microcosm demos (a ~500-line toy compiler-in-Pyret that
                         proved every WASM-emission mechanism). SUPERSEDED by self-host/ +
                         self-compiler/; kept for reference and the dual-run fixpoint tests.
examples/                small standalone .arr programs
test/                    ~64 *.test.ts suites (see Testing)
pyret/                   upstream Pyret (brownplt/pyret-lang) — reused parser, the .arr passes
                         we copied, the pitometer benchmark suite, and the baseline compiler
                         (a gitignored symlink to ../pyret)
ROADMAP.md               detailed design notes + progress log
UNSUPPORTED.md           features out of scope (type-check fixtures, IO/networking/tables/
                         charts/reactor, compiler-as-library, non-core troves, RNG)
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
bun run src/cli.ts run examples/frac.arr      # or: bun run pyretc run <file.arr>
bun run src/cli.ts run --self-hosted <file>   # route through the Pyret-written compiler
                                              # (bounded subset; falls back to the seed)
PYRET_DUMP=1 bun run pyretc run <file.arr>     # also dump the generated .wat
```

### Web IDE

```bash
bun run build:web                 # build web/cps-compile-driver.wasm + bundle web/main.ts
PORT=7000 HOST=0.0.0.0 bun scripts/serve.ts   # then open http://localhost:7000
```

The IDE runs your code **on the UI thread** (no Web Worker), through exactly **one
artifact**: `web/cps-compile-driver.wasm` — the pure-Pyret parser + the CPS stoppability
transform + the self-hosted backend, all seed-compiled to WASM. There is **no seed
fallback**, no JS parser, no separate CPS pass in the bundle. The browser bundle
(`main.bundle.js`, ~38 KB) is just host imports + the inlined prelude text + IDE glue.

Try Run/Stop (an infinite loop is interruptible), the REPL, images, and the **Examples
dropdown** in the header (drawing images, a stoppable printing loop, a lambda-calculus
interpreter, rough numbers). Example image expression:
`above(beside(circle(40, "solid", "red"), square(60, "solid", "blue")),
image-url("https://.../photo.jpg"))`.

### Deploy (static / GitHub Pages)

The IDE is a **fully static site** — HTML + JS (+ source maps) + `.wasm` driver artifacts,
no server-side code at runtime. `bun run build:web` emits everything into `web/`, which can
be served by any static host:

```bash
bun run build:web
cd web && python3 -m http.server 8000   # or any static file server
```

A GitHub Actions workflow (`.github/workflows/deploy-pages.yml`) builds and publishes `web/`
to **GitHub Pages** on push to `master`/`main` (or via *Run workflow*). The build is
**hermetic** — the JS-GLR parser the seed needs is vendored under `vendor/pyret-lang/`, so CI
needs no external `pyret-lang` checkout. **One-time setup:** in the repo, *Settings → Pages →
Build and deployment → Source = GitHub Actions.*

> Because it's static, there is **no CORS image proxy**. `image-url(...)` loads images
> directly with `crossOrigin="anonymous"`: images from hosts that send CORS headers work
> (including pixel ops); images from hosts that don't will fail to load or taint the canvas.
> That's an accepted limitation of the static deploy.

### Test

```bash
bun test ./test        # ~437 pass / 0 fail
```

> Use `bun test ./test`, not bare `bun test` — the latter would also pick up upstream
> Pyret's own JS tests under `pyret/`.

### Original Pyret (benchmark baseline)

The checked-in `pyret/lang/build/phase0/pyret.jarr` is a **stale bootstrap** (out of sync
with `src/arr`), so it must be rebuilt once from current source:

```bash
# Node via nvm (bun can drive the bootstrap compile, but cannot RUN the standalone —
# it rejects the standalone's duplicate `_` params, which Node allows).
nvm install --lts                 # → ~/.nvm/versions/node/v24.*/bin/node
cd pyret/lang
npm install --no-save --ignore-scripts ws
bunx browserify src/js/trove/require-node-compile-dependencies.js \
  -o build/phaseA/bundled-node-compile-deps.js
cp build/phase0/js/pyret-parser.js build/phaseA/js/
bun build/phase0/pyret.jarr --outfile build/phaseA/pyret.jarr \
  --build-runnable src/arr/compiler/pyret.arr \
  --builtin-js-dir src/js/trove/ --builtin-arr-dir src/arr/trove/ \
  --compiled-dir build/phaseA/compiled/ \
  --deps-file build/phaseA/bundled-node-compile-deps.js -no-check-mode \
  --require-config src/scripts/standalone-configA.json
node build/phaseA/pyret.jarr --run some.arr        # use print(...) to see a value
```

---

## Architecture: how a program becomes WebAssembly

```
Pyret source
   │  (1) PARSE        self-host/pyret-parser.arr → AST  [pure Pyret, no JS]
   │                   ── or (seed/CLI only) ──→ Pyret's JS GLR parser → CST  [JS]
   ▼
  AST  (ast.arr nodes)
   │  (1b) CPS         self-host/cps-ast.arr: ast→ast stoppability transform  [pure Pyret]
   │                   (web IDE and stoppable builds only; inserts yield-check/finish-result)
   ▼
  AST (CPS form)
   │  (2) FRONT-END    desugar · resolve-scope · ANF   [Pyret passes, reused]
   ▼
  ANF
   │  (3a) SEED PATH   compile.ts walks the CST, emits WASM via binaryen   [TypeScript seed]
   │  (3b) SELF-HOST   wasm-of-pyret.arr → encoder.arr (binary) + runtime.arr  [pure Pyret]
   │                   (lowers CPS intrinsics; exports `resume` for the trampoline)
   ▼
  .wasm module  =  program code  +  runtime  +  the Pyret-written stdlib (prelude.arr)
   │  (4) RUN          WebAssembly.instantiate; call `main`; host imports do I/O
   ▼
  output / values / images
```

The **web IDE** runs exclusively through path (3b): `cps-compile-driver.wasm` = step (1)
pure-Pyret parser + step (1b) CPS + step (3b) self-hosted backend, all in one WASM
artifact. The seed never runs at web-IDE runtime.

### What is in JavaScript vs WebAssembly

**In WebAssembly (everything that runs your program):**
- The **value model**: numbers (`$Fixnum`/`$Bignum` integers, `$Rational`, `$Roughnum`),
  strings, booleans, `nothing`, closures, `data` variants, objects, tuples, lists — all
  WASM-GC structs/arrays.
- The **runtime**: arithmetic with type dispatch and contagion, equality/compare, gcd +
  rational reduction, bignum long division, string ops, value rendering, the check
  harness, and the CPS yield/resume primitives. (Two implementations exist: `runtime.ts`
  emitted by the seed, and `runtime.arr` emitted by the self-hosted compiler.)
- **All compiled user code** *and* the **standard library** (`prelude.arr`), so even
  `map`/`filter`/`foldl` are WASM.
- **Proper tail calls** (`return_call_indirect`) and **error unwinding** (a raised error
  throws a JS value that unwinds natively through WASM frames — we deliberately avoid the
  WASM exception-handling proposal).

**In JavaScript (the seed + the irreducible glue):**
- The **seed compiler** (`src/compiler`, `src/parser`) — the bootstrap that produces WASM.
  The self-hosted compiler has no JS in its codegen path; the seed is build-time only.
- The **JS-GLR parser** (Pyret's own, reused) — kept as a seed/CLI crutch only; the web
  IDE uses only the pure-Pyret parser. Eventually the self-hosted path will drop it entirely.
- The **I/O boundary** (`run.ts`): `print`, `raise`, check-harness reporting, `emit-byte`,
  `do_pause`. A few dozen lines.
- The **stop-button driver** (`run-stoppable.ts`): catches the pause signal, yields to the
  event loop so a Stop click is serviced on the same thread, then resumes via the exported
  `resume` function — or aborts. This genuinely needs JS (the event loop).
- The **web shell**: CodeMirror editor, the canvas image renderer (`image.js`), DOM wiring.

### The Stop button (stoppable codegen)

The IDE runs user code on the UI thread, so Stop can't `worker.terminate()`. Instead the
**ast→ast CPS transform** (`self-host/cps-ast.arr`) turns the program into
continuation-passing style and inserts a `yield-check` at function entry. The self-hosted
backend (`wasm-of-pyret.arr`) lowers `yield-check` to a `$yield` intrinsic: it decrements
a `$gas` counter and, when exhausted, stashes the continuation in `$paused-thunk` and
throws `do_pause` to the JS trampoline. The trampoline yields to the event loop (so a Stop
click runs and sets a flag), then resumes via the exported `resume` function — or, if Stop
was pressed, doesn't. A `print` call forces a yield so output streams live. Because the
compiler emits **native proper tail calls**, CPS's pervasive tail calls don't grow the
stack, so overhead is tiny (≈1.1×) — far less than Stopify-style JS trampolining (2–10×).
The Pyret-written stdlib is CPS'd too, so built-in higher-order functions are interruptible;
primitives (bignum ops) are not instrumented, since they're bounded.

### Engine baseline

Targets **WASM-GC + tail calls** only — universal in current browsers since Safari 18.2
(Dec 2024) and present in bun/JSC. No other engine proposals are required.

---

## Benchmarks

Two configurations, on Pyret's own `pitometer` programs
(`pyret/lang/pitometer/programs/`). Numbers below were taken on this machine; treat them
as relative, not absolute.

### Runtime configuration per config

| Config | What runs | Harness | Timing |
|---|---|---|---|
| **CPS self-hosted Pyret→WASM (CLI, immediate-resume)** | `web/cps-compile-driver.wasm` — the self-hosted Pyret compiler + CPS stoppability transform, the SAME artifact the web IDE ships, compiled entirely in WASM (no JS seed, no fallback). Emitted module run via immediate-resume trampoline (no event-loop yield — raw throughput). CLI: `pyretc run --stoppable <file.arr>` | `bun scripts/bench-cps.ts 5` on **bun 1.3.14** | best of 5; "run" excludes compile |
| **original Pyret** | a rebuilt `phaseA` standalone (`--build-runnable`), executed with **Node** | `bash scripts/bench-pyret-baseline.sh` on **Node v24.18.0** | best of 3; total includes ~165 ms Node+runtime startup |

### Results (freshly measured, this machine)

| program | CPS self-hosted Pyret→WASM (run) | original Pyret (compute / total)¹ |
|---|---|---|
| `adding-ones-2000` | **compile fail**² | 18 ms / 183 ms |
| `recursion-triangle-20000` | **5.5 ms** ✓ (was: stack overflow on direct path) | 30 ms / 195 ms |
| `tail-sum-1000000` | 107 ms | 90 ms / 255 ms |

¹ original-Pyret figures **freshly measured** (`bash scripts/bench-pyret-baseline.sh`, Node v24.18.0,
best of 3, `phaseA` already built): *total* is wall-clock including a ~165 ms Node+runtime startup
baseline (a trivial `print(1)`), and *compute* is total minus that baseline. Startup varies slightly
run-to-run; all compute figures are rounded to the nearest 5 ms.

² `adding-ones-2000` is a single expression with 2000 literal additions. The CPS driver's recursive
AST traversal hits the JS call stack limit before emitting any code. The original Pyret compiler
handles it fine because it does not recurse as deeply. This is a compiler-side stack limit, not a
runtime limit; a trampoline or iterative AST walk in the CPS transform would fix it.

### Takeaways (honest)

- **`recursion-triangle-20000` now RUNS under the CPS path** — 5.5 ms versus a stack overflow on the
  direct seed path. CPS converts deep non-tail recursion into native WASM tail calls, so arbitrarily
  deep non-tail recursion becomes constant-stack. Original Pyret survives the same case via its own
  Stopify trampoline (~30 ms compute).
- **CPS self-hosted is the SAME artifact the web IDE ships** — no separate seed compile, no JS codegen
  at runtime. The CLI flag `pyretc run --stoppable` exercises the identical path.
- **`tail-sum` is close** (107 ms vs 90 ms compute). Our runtime allocates a `$Fixnum` GC object every
  step; `js-numbers` keeps sums under 2⁵³ unboxed. An unboxed-i64 fast path would close this gap.
- **`adding-ones-2000` compile fails** — a compiler stack-depth bug, not a runtime issue. Not a
  regression; the direct seed path compiles it fine. Fix is an iterative CPS AST walk.
- Compile times (best-of-1): triangle ~555 ms, tail-sum ~430 ms. These run once at startup and
  are not included in the "run" column. Compile performance is a future optimization target.

Methodology: `bun 1.3.14`, Node v24.18.0; all figures machine-relative, not absolute. Config B
"run" = best-of-5 wall-clock, prelude prepended, immediate-resume (no setTimeout between pauses).
Config A startup baseline = average of three `trivial` (`print(1)`) measurements (~165 ms).

---

## Testing & results

`bun test ./test` → **~437 pass / 0 fail** across ~64 suites. Highlights:

| Area | Covers |
|---|---|
| `e2e.test.ts` + the feature suites | full pipeline: number tower, strings, data/cases, objects, lists, closures, tail calls, error messages, `check` blocks, multi-module, modules + name-collision resolution |
| `selfhost-e2e.test.ts` | the **self-hosted** compiler: a program compiled by the Pyret-written compiler (no JS codegen) to a runnable WASM module |
| `selfhost-stoppable.test.ts` | the self-hosted CPS path: Stop interrupts an infinite loop, pause/resume work, via the pure-Pyret backend's `$yield`/`resume` |
| `cps-ast.test.ts` + `cps.test.ts` + `stoppable.test.ts` | the ast→ast CPS transform preserves semantics; Stop interrupts an infinite loop / a built-in `each` on one thread |
| `pyret-parser.test.ts` | the **pure-Pyret parser**: parses real source (incl. real compiler/library files, large files via constant-stack tokenizer) into the real `ast.arr` AST |
| `surface-parse.test.ts` | the JS-GLR `surface-parse` crutch: ~38 grammar forms rebuilt into `ast.arr` |
| `runtime.test.ts` | the WASM number tower directly (add/sub/mul/divide, equality, compare, rendering) |
| `image.test.ts` | the image library (constructors, sizing, scene-graph serialization) |
| `pipeline-runs.test.ts` + `frontend-runs.test.ts` | the seed-compiled real front-end loads and runs (desugar/well-formed/resolve-scope/anf) |

How the code is tested:
- **Output comparison** — compile a Pyret string to WASM, run it, assert on captured output
  (e.g. `tail-sum-1000000` → `500000500000`). Stoppable tests additionally assert the CPS
  result equals the direct-compiler result and that a stop request terminates an otherwise
  infinite computation.
- **Self-hosted path** — `selfhost-e2e.test.ts` builds `compile-driver.arr` with the seed,
  runs it to emit a user program's WASM, then runs *that*.
- **Headless browser** (`PORT=8099 bun scripts/serve.ts` then `PORT=8099 bun scripts/ide-test.ts`,
  driving real Chrome via puppeteer-core): runtime ready on the UI thread, `fact(20)`
  bignum, a `check` summary, CodeMirror mounted, REPL in context, image canvases, and **Stop
  interrupts an infinite loop on the UI thread**.
- **Corpus scoreboard** (`bun scripts/run-corpus.ts pyret/lang/tests`) — runs Pyret's own
  `.arr` tests one subprocess each. A *health metric* to track progress, not the success
  criterion.
- **Fixpoint gate** (`bun scripts/fixpoint-bytecompare.ts`) — iterates the self-hosted
  compiler compiling its own merged source until two consecutive generations are
  byte-identical. **Achieved**: compiler5 === compiler4.

---

## Next steps

1. **Expand self-hosted language coverage.** The fixpoint is achieved on the compiler's own
   source, but user programs that exercise language features not present in the compiler
   (e.g. certain `check:` op forms, nested `data` ctors in `cps-ast`, `satisfies`/`raises`)
   may surface compiler errors in the web IDE. Growing coverage closes those gaps.
2. **Corpus pass rate.** Run Pyret's own ~342 `.arr` test programs through the self-hosted
   path (`bun scripts/selfhost-corpus.ts test-corpus`). This is the scoreboard for language
   completeness.
3. **Unboxed-number fast path.** An unboxed-`i64` representation for integers that fit, so
   arithmetic stops allocating a `$Fixnum` per step (the one place original Pyret beats us).
4. **Rich rendering + a debugger.** `code.pyret.org`-style structured value/table rendering,
   and a step/breakpoint debugger built on the CPS pause/resume infrastructure (Pause ⏸ /
   Step ⏭ buttons are already wired in the IDE).
5. **Drop the JS-GLR parser from the seed/CLI path.** The pure-Pyret parser is nearly
   complete (83/84 files); once the last large file parses, the seed's JS-GLR crutch can be
   retired and the CLI unified on the pure-Pyret path.
