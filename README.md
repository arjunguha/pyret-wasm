# Pyret on WebAssembly

A from-scratch **WebAssembly compiler and runtime for the Pyret language**, plus a
`code.pyret.org`-style web IDE — all running on `bun` (server/CLI) and in the browser.

The goal is to match Pyret's semantics exactly: the full number tower (exact
arbitrary-precision integers, exact rationals, and IEEE "roughnums" with Pyret's
contagion rules), proper tail calls, Pyret's renowned error messages, and a working
**Stop button** — with the value model and runtime implemented *in WebAssembly* rather
than leaning on `js-numbers.js`. On the web, only the things WASM genuinely can't do
(DOM, editor, canvas, the event loop) live in a thin layer of JavaScript.

The headline ambition is a **self-hosting compiler**: a Pyret compiler *written in
Pyret*, compiled to WebAssembly by a TypeScript "seed", eventually reaching a **fixpoint**
(the compiler compiling its own source to a byte-identical module).

---

## The three compilers

This repo contains three cooperating compilers (a deliberate design, not redundancy):

1. **The seed** — written in **TypeScript** (`src/`), Pyret → WASM via
   [`binaryen`](https://github.com/WebAssembly/binaryen). It is the bootstrap and is
   *kept* (also a fallback for syntax the self-hosted compiler can't yet handle). Its job
   is to compile the other compilers — which are written in Pyret — down to WebAssembly.

2. **The self-hosted compiler** — written in **Pyret** (`self-host/` + a copy of Pyret's
   real front-end in `self-compiler/`), the actual deliverable. It compiles Pyret → WASM
   with **no JavaScript in the codegen path**:
   `source → parse → desugar → resolve-scope → ANF → wasm-of-pyret → (Pyret-written WASM
   encoder + runtime) → runnable module`. **End-to-end compilation works today** for
   simple programs (a real program flows all the way to a runnable WASM-GC module with no
   JS codegen); work is ongoing to climb from there to the full language and the fixpoint.

3. **The CPS transform** — a **Pyret → Pyret** source-to-source pass (`self-host/cps.arr`)
   that makes programs cooperatively stoppable (the IDE's Stop button), composed *before*
   the normal compiler. Stoppability lives entirely in this Pyret transform — there is no
   stop logic in the seed.

There are likewise **two parsers**: a temporary JavaScript GLR parser (Pyret's own,
reused) used as a crutch, and a permanent **pure-Pyret parser** (`self-host/pyret-parser.arr`,
no JS) that already parses most of the real compiler source — the JS-free parsing the
fixpoint ultimately requires.

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
| Self-hosted compiler: **end-to-end source → runnable WASM, no JS codegen** | ✅ simple programs |
| Pure-Pyret parser (no JS), parses real compiler source | ✅ ~50/76 files |
| Self-hosted: full language + operators/`if`/funcs/`check` end-to-end | 🚧 in progress |
| The fixpoint (compiler.wasm recompiles itself, byte-identical) | 🚧 not yet |

Unit/e2e tests: **~235 pass / 0 fail** (`bun test ./test`). Pyret's own `.arr` corpus is
tracked as a *health metric*, not the target.

---

## Repository layout

```
src/                     The SEED compiler + runtime (TypeScript)
  cli.ts                 `pyretc run [--self-hosted] <file.arr>` entry point
  build.ts               buildSource / buildSourceFile: parse → compile → wasm (+ multi-module inlining)
  build-core.ts          parser-agnostic build helper
  build-stoppable.ts     STOPPABLE build: run the Pyret CPS transform, then compile
  build-stoppable-core.ts  parser-agnostic stoppable build (used by the browser bundle)
  build-selfhost.ts      route a program through the Pyret-written compiler (--self-hosted)
  parser/
    pyret-parser.ts      wraps Pyret's reused JS tokenizer + generated GLR parser (Node/bun)
    parser-browser.ts    same parser, wired for the browser
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
  compile-driver.arr     end-to-end driver: source → … → wasm-of-pyret → bytes (tested e2e)
  wasm-of-pyret.arr      the ANF → WASM-GC backend (replaces Pyret's js-of-pyret)
  encoder.arr            a WASM-GC binary encoder in Pyret (binaryen's role, in Pyret)
  runtime.arr            the runtime emitter in Pyret (number tower, renderer, check harness…)
  pyret-parser.arr       the PURE-PYRET parser (tokenizer + recursive descent, no JS)
  parse-from-tree.arr    rebuilds ast.arr nodes from the JS-GLR bridge (the crutch path)
  cps.arr / cps-driver.arr  the Pyret→Pyret CPS stoppable transform + its driver
  *-notes.md             coverage/plan notes (parser, namespace)

self-compiler/           A COPY of Pyret's real in-Pyret compiler, reused + modifiable
  compiler/              desugar, resolve-scope, anf, well-formed, type-check, ast-anf, … (29 files)
  trove/                 ast.arr, the stdlib troves the front-end imports (47 files)

web/                     The browser IDE (served statically; user code runs on the UI thread)
  index.html  ide.js  image.js  main.ts → main.bundle.js  vendor/ (CodeMirror + Pyret mode)

scripts/
  serve.ts               static server for the IDE (PORT, HOST env)
  bench.ts               benchmark: seed Pyret→Wasm on the pitometer programs
  bench-pyret-baseline.sh benchmark: original Pyret (rebuilds + times standalones)
  ide-test.ts            headless-Chrome smoke test of the IDE (puppeteer-core)
  run-corpus.ts          runs Pyret's own .arr test corpus as a scoreboard
  selfhost-fixpoint.ts   the fixpoint gate/meter
  gen-parser-bundle.ts / gen-cps-driver.ts   browser bundle artifacts

selfhost/                EARLIER microcosm demos (a ~500-line toy compiler-in-Pyret that
                         proved every WASM-emission mechanism). SUPERSEDED by self-host/ +
                         self-compiler/; kept for reference and the `--self-hosted` subset path.
examples/                small standalone .arr programs
test/                    ~45 *.test.ts suites (see Testing)
pyret/                   upstream Pyret (brownplt/pyret-lang) — reused parser, the .arr passes
                         we copied, the pitometer benchmark suite, and the baseline compiler
                         (a gitignored symlink to ../pyret)
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
bun run src/cli.ts run examples/frac.arr      # or: bun run pyretc run <file.arr>
bun run src/cli.ts run --self-hosted <file>   # route through the Pyret-written compiler
                                              # (bounded subset; falls back to the seed)
PYRET_DUMP=1 bun run pyretc run <file.arr>     # also dump the generated .wat
```

### Web IDE

```bash
bun run build:web                 # parser bundle + cps driver + bundle web/main.ts
PORT=7000 HOST=0.0.0.0 bun scripts/serve.ts   # then open http://localhost:7000
```

The IDE runs your code **on the UI thread** (no Web Worker). Try Run/Stop (an infinite
loop is interruptible), the REPL, and images, e.g.
`above(beside(circle(40, "solid", "red"), square(60, "solid", "blue")),
image-url("https://.../photo.jpg"))`.

### Test

```bash
bun test ./test        # ~235 pass / 0 fail
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
   │  (1) PARSE        Pyret's JS GLR parser → CST  [JS, temporary]   ── or ──→
   │                   self-host/pyret-parser.arr → AST  [pure Pyret, no JS]
   ▼
  AST  (ast.arr nodes)
   │  (2) FRONT-END    well-formed · desugar · resolve-scope · ANF   [Pyret passes, reused]
   ▼
  ANF
   │  (3a) SEED PATH   compile.ts walks the CST, emits WASM via binaryen   [TypeScript seed]
   │  (3b) SELF-HOST   wasm-of-pyret.arr → encoder.arr (binary) + runtime.arr  [pure Pyret]
   ▼
  .wasm module  =  program code  +  runtime  +  the Pyret-written stdlib (prelude.arr)
   │  (4) RUN          WebAssembly.instantiate; call `main`; host imports do I/O
   ▼
  output / values / images
```

The optional **CPS transform** (`self-host/cps.arr`) is composed before step 3 for the
stoppable build.

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
  The self-hosted compiler is moving codegen into WASM (no JS in its codegen path).
- The **JS-GLR parser** (Pyret's own, reused) — a *temporary* crutch; the pure-Pyret
  parser is its no-JS replacement.
- The **I/O boundary** (`run.ts`): `print`, `raise`, check-harness reporting, `emit-byte`,
  `do_pause`. A few dozen lines.
- The **stop-button driver** (`run-stoppable.ts`): catches the pause signal, yields to the
  event loop so a Stop click is serviced on the same thread, then resumes via the exported
  continuation — or aborts. This genuinely needs JS (the event loop).
- The **web shell**: CodeMirror editor, the canvas image renderer (`image.js`), DOM wiring.

### The Stop button (stoppable codegen)

The IDE runs user code on the UI thread, so Stop can't `worker.terminate()`. Instead the
**Pyret→Pyret CPS transform** (`self-host/cps.arr`) turns the program into
continuation-passing style and inserts a `yield-check` at function entry. Periodically the
running code returns to a tiny JS trampoline (`run-stoppable.ts`), which yields to the
event loop (so a Stop click runs and sets a flag), then resumes via the captured
continuation — or, if Stop was pressed, doesn't. Because the compiler emits **native
proper tail calls**, CPS's pervasive tail calls don't grow the stack, so overhead is tiny
(≈1.1×) — far less than Stopify-style JS trampolining (2–10×). The Pyret-written stdlib is
CPS'd too, so built-in higher-order functions are interruptible; primitives (bignum ops)
are not instrumented, since they're bounded.

### Engine baseline

Targets **WASM-GC + tail calls** only — universal in current browsers since Safari 18.2
(Dec 2024) and present in bun/JSC. No other engine proposals are required.

---

## Benchmarks

Three configurations, on Pyret's own `pitometer` programs
(`pyret/lang/pitometer/programs/`). Numbers below were taken on this machine; treat them
as relative, not absolute.

### Runtime configuration per config

| Config | What runs | Harness | Timing |
|---|---|---|---|
| **direct Pyret→Wasm (seed)** | `buildSourceFile` (Pyret→CST→binaryen→wasm), then `WebAssembly.instantiate` + call `main` | `bun scripts/bench.ts` on **bun 1.3.14** | best of N; "run" excludes compile |
| **stoppable Pyret→Wasm** | `buildStoppableSourceFile` (Pyret CPS transform first) run through `runStoppable` with `noYield:true` (raw throughput; still interruptible) | manual driver over the same programs, **bun 1.3.14** | best of 3 |
| **original Pyret** | a rebuilt `phaseA` standalone (`--build-runnable`), executed with **Node** | `bash scripts/bench-pyret-baseline.sh` on **Node v24** | best of 3; total includes ~183 ms Node+runtime startup |

### Results (best of 3, this machine)

| program | direct Pyret→Wasm (run) | stoppable Pyret→Wasm (run) | original Pyret (compute / total)¹ |
|---|---|---|---|
| `adding-ones-2000` | 8.1 ms | 10.3 ms | 22 ms / 205 ms |
| `recursion-triangle-20000` | **stack overflow** | 8.7 ms | 21 ms / 204 ms |
| `tail-sum-1000000` | 122.7 ms | 142.6 ms | 97 ms / 280 ms |

¹ original-Pyret figures **freshly measured** (`bash scripts/bench-pyret-baseline.sh`, Node
v24, best of 3, after rebuilding `phaseA` per the recipe above): *total* is wall-clock
including a ~183 ms Node+runtime startup baseline (a trivial `print(1)`), and *compute* is
total minus that baseline. The direct/stoppable columns are measured with `bun scripts/bench.ts 5`.

### Takeaways (honest)

- **Stoppability is nearly free (~1.1–1.3×)** — native WASM tail calls mean the CPS form
  doesn't trampoline.
- **CPS *enables* deep non-tail recursion** (`recursion-triangle-20000`) that overflows the
  direct path's native stack; original Pyret survives the same case via its own Stopify
  trampoline.
- Our WASM **beats original Pyret on the short programs** (no ~183 ms Node startup).
- Original Pyret **wins `tail-sum`**: `js-numbers` keeps sums under 2⁵³ *unboxed*, while our
  runtime allocates a `$Fixnum` every step — a concrete optimization target (see Next steps).

---

## Testing & results

`bun test ./test` → **~235 pass / 0 fail** across ~45 suites. Highlights:

| Area | Covers |
|---|---|
| `e2e.test.ts` + the feature suites | full pipeline: number tower, strings, data/cases, objects, lists, closures, tail calls, error messages, `check` blocks, multi-module, modules + name-collision resolution |
| `selfhost-e2e.test.ts` | the **self-hosted** compiler: a program compiled by the Pyret-written compiler (no JS codegen) to a runnable WASM module |
| `pyret-parser.test.ts` | the **pure-Pyret parser**: parses real source (incl. real compiler/library files) into the real `ast.arr` AST, with real srclocs |
| `surface-parse.test.ts` | the JS-GLR `surface-parse` crutch: ~38 grammar forms rebuilt into `ast.arr` |
| `cps.test.ts` + `stoppable.test.ts` | the CPS transform preserves semantics, and Stop interrupts an infinite loop / a built-in `each` on one thread |
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
  criterion; the self-hosted compiler is what must eventually pass the full suite.
- **Fixpoint gate** (`bun scripts/selfhost-fixpoint.ts`) — meters progress toward the
  compiler recompiling its own source.

---

## Next steps

1. **Climb the self-hosted ladder.** Wire `desugar` + `resolve-scope` (with a minimal
   `CompileEnvironment`) into `compile-driver.arr` so operators, `if`, function defs, and
   `check` blocks compile end-to-end through the Pyret-written compiler — then larger
   programs, then the corpus.
2. **Make the pure-Pyret parser constant-stack.** It already parses ~50/76 real compiler
   files; the largest (80–130 KB) overflow the WASM stack because some recursions grow with
   file size. Convert them to tail-recursive form (the compiler does native tail calls) so
   the parser can read the whole compiler — a prerequisite for JS-free parsing.
3. **Reach the fixpoint.** Get the self-hosted compiler to compile its own source to a
   byte-identical module (`scripts/selfhost-fixpoint.ts` is the gate), then route CLI/IDE/
   tests through it (seed retained as bootstrap/fallback).
4. **Unboxed-number fast path.** An unboxed-`i64` representation for integers that fit, so
   arithmetic stops allocating a `$Fixnum` per step (the one place original Pyret beats us).
5. **Shrink the JavaScript glue.** Trim `web/main.bundle.js` (mostly bundled binaryen + the
   parser) toward the "minimal JS" goal — lazy-load/drop binaryen once self-hosting lands,
   and split the parser out (eventually replaced by the pure-Pyret parser).
6. **Rich rendering + a debugger.** `code.pyret.org`-style structured value/table rendering,
   and a step/breakpoint debugger built on the CPS pause/resume infrastructure.
