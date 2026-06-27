# Pyret-on-WebAssembly — Architecture & Roadmap

A from-scratch WebAssembly compiler and runtime for the **full** Pyret language,
running both on `bun` and in the browser, with a `code.pyret.org`-style IDE.

## Hard requirements (from the goal)

1. **Compiler AND runtime in WebAssembly** — including the lexer and parser
   (eventually). The TypeScript you see is a *bootstrap seed*, not the deliverable.
2. **Full language**, not a subset. Pyret's own ~342 `.arr` tests are the scoreboard
   and must pass in translation.
3. **Numbers implemented in WASM** — exact arbitrary-precision integers, exact
   rationals, and IEEE roughnums with Pyret's exact contagion/rounding semantics.
   No dependency on `js-numbers.js`.
4. **Tail calls, exact error messages, and the stop button** all work.
5. Minimal JS glue on the web (only what WASM genuinely cannot do: DOM, editor).
6. **User code runs on the UI THREAD — NO Web Worker** (user directive, 2026-06-26),
   for async image loading + JS interop. So compiled *user* code must **suspend and
   yield to JS several times/sec**; the Stop handler runs and sets a flag; if unset,
   JS **resumes** the WASM, else it aborts. JS IS required here (minimal: the
   yield/resume driver + flag). **Architecture (user-specified):** a SEPARATE
   **Pyret→Pyret source-to-source pass** that inserts yield points (top of functions
   and loop bodies), **composed BEFORE** the normal Pyret→WASM compiler — the main
   self-hosted compiler stays UNTOUCHED. Built-in higher-order fns (map, each, foldl,
   …) MUST be interruptible — they're Pyret-written, so the transform covers them.
   Do NOT instrument primitives (bignum ops, etc.) — they're bounded.
   **MECHANISM = CPS** (JSPI is NOT widely supported, user 2026-06-26): the Pyret→Pyret
   pass is a continuation-passing-style transform; at a yield point it returns control
   to a tiny JS driver (trampoline) which yields to the event loop (Stop handler sets a
   flag), then RESUMES by invoking the continuation, or ABORTS if the flag is set.
   CPS makes everything tail calls — fine because our Pyret→Wasm compiler does NATIVE
   proper tail calls (return_call), so no stack overflow (this is exactly why Stopify
   has to trampoline in JS; we don't). Comes AFTER self-hosting, REQUIRED BEFORE the
   IDE. SUPERSEDES worker.terminate() (web/worker.ts).

## Engine baseline

Targets **WASM-GC + tail calls** only (universal in latest browsers since Safari
18.2, Dec 2024; verified in bun/JSC). Deliberately avoids the WASM
exception-handling proposal — `raise`/errors throw JS values (unwind through WASM
natively); catch points are exported thunks wrapped in JS `try/catch`; the stop
button throws an Interrupt from an imported gas-check. Backend: `binaryen` v130.

## Reuse (key decision)

Pyret's compiler is itself written in Pyret + JS, and we **reuse it**:
- **Front-end (JS):** `pyret-tokenizer.js` + generated `pyret-parser.js` (GLR) run
  unmodified in bun via requirejs/jglr and yield an unambiguous CST. VALIDATED.
  The backend consumes this CST. (Our hand-written TS lexer in `src/parser/` is
  kept only as a reference.)
- **Middle (Pyret `.arr`):** `well-formed`, `desugar`, `resolve-scope`, `anf`
  passes are reused for self-hosting — compiled to WASM by our backend.
- **New work:** a `wasm-of-pyret` codegen replacing `js-of-pyret`, plus the WASM
  runtime (number tower, values, builtins). These are the only genuinely novel pieces.

## Bootstrap chain (how the compiler becomes WASM)

```
Stage 0  Seed: reuse Pyret JS parser -> CST; our TS backend -> binaryen -> .wasm
         + WASM runtime. Runs on bun. Job: compile enough Pyret to build Stage 1.

Stage 1  Runtime in WASM: number tower, value model (GC structs),
         equality, the testing harness, builtins. Hand-built via binaryen,
         then progressively rewritten in Pyret.

Stage 2  Self-hosted compiler: lexer+parser+desugar+codegen rewritten in
         *Pyret*, compiled by Stage 0 -> compiler.wasm.
         Now lexer/parser/compiler are all WebAssembly.

Stage 3  Fixpoint: compiler.wasm recompiles its own source, bit-identical.
         Retire the TS seed. Mirror Pyret (its compiler is in pyret/lang/src/arr).
```

## Value model (WASM-GC)

`$Num` base struct (tag) with subtypes Fixnum(i64) / Bignum(limbs) / Rational /
Roughnum(f64); strings, booleans, nothing, functions (closures via
`return_call_ref`), and `data` variants as GC structs with a brand/vtable.

## Progress

- [x] Engine feature probe (GC, tail calls, exceptions) — confirmed in bun.
- [x] Front-end: reuse Pyret's JS tokenizer + GLR parser (full language) → CST.
- [x] WASM number tower Phase A: exact int + exact rational (reduce/sign/contagion)
      + roughnum, all in WASM. `num_add/sub/mul/divide`, equal, compare,
      int→decimal & rational→string. 7 runtime tests pass.
- [x] Value model (anyref; numbers as (ref $Num), bool/nothing as i31) + codegen
      + end-to-end `pyretc run`. 17 tests pass.
- [x] Language so far: int/rational/rough literals, + - * /, comparisons, and/or,
      booleans, parens, if/else/else-if, let-bindings, identifiers, top-level
      `fun` defs, application, recursion, mutual recursion.
- [x] Proper tail calls via `return_call` — verified 2,000,000-deep tail recursion.
- [x] Strings ($Str = GC array i8): literals, `+` concat, `==`, display.
      `+`/`==` now dispatch on type at runtime ($plus/$equal).
- [x] `check:`/`check "name":`/`examples:` blocks with `is`: runtime pass/fail
      counters, value-rendered failure messages, Pyret-style summary. 19 tests pass.
      THIS IS THE SCOREBOARD MECHANISM for pyret/lang/tests.
- [x] `data` declarations: variants, constructors, nullary singletons,
      auto `is-<variant>` predicates, structural equality, nested rendering
      (`node(1, node(2, mt))`). `cases` with field binding, recursive. 23 tests.
- [x] Runtime errors raise Pyret-style messages via host `raise` (JS exception
      unwinds through WASM, no EH proposal): division by zero, `cases` no-match,
      `if` no-branch. Surfaced by run.ts / CLI.
- [x] Lambdas + closures + higher-order functions. Uniform closure calling
      convention ($Closure {fnIndex, caps}) via a function table + call_indirect /
      return_call_indirect. Free-var analysis + closure conversion. Local `fun`
      defs. Tail calls preserved through indirect calls (3M-deep verified).
- [x] Lists + standard prelude WRITTEN IN PYRET (data List + length/map/filter/
      foldl/foldr/sum/append/reverse/member), compiled by our own backend and
      prepended via src/build.ts. `[list: ...]` desugars to link/empty. 27 tests.
- [x] check ops `is-not` and `satisfies` (+ `$check_pred`). 28 tests.
- [x] Fixed exact-ref feature bug (FEATURES mask) — important for browsers too.
- [x] Web IDE REWORKED TO UI THREAD (no Web Worker) — requirement 6 satisfied.
      web/main.ts (-> main.bundle.js) exposes window.PyretRunner.run -> {stop, promise},
      building via the STOPPABLE (CPS) pipeline + runStoppable's single-thread
      trampoline. Stop is COOPERATIVE (flag at each CPS yield; loop yields to the event
      loop so the click is serviced same-thread). Programs using not-yet-CPS'd syntax
      (check blocks) fall back to a direct build (runs, not stoppable). All headless
      checks pass (bun scripts/ide-test.ts): ready, fact(20) bignum, check summary,
      CodeMirror, REPL, and STOP interrupts an infinite loop on the UI thread. Old
      web/worker.ts + worker.bundle.js DELETED. [parser-bundle/build notes below]
      [original notes below kept for the parser-bundle / build mechanics, still useful]
      Compiles + runs Pyret 100% client-side (WASM in a Web Worker); Stop =
      worker.terminate() + respawn (kills infinite loops). No login, no Drive.
      `bun run build:web` then `bun run serve`. Pyret parser reused in-browser via
      a generated AMD-shim bundle (web/parser-bundle.js, kept external from the
      binaryen bundle and loaded at runtime). scripts/ide-test.ts is a headless
      smoke test (Run + Stop). Browser gotchas fixed: alias window→worker global
      for jglr timing; declare `var match` (strict-mode ESM); guard `process`.
- [x] Objects: literals `{f: e, method m(self,...): ...}`, dot-access, method
      calls (self-binding, runtime method/field dispatch), structural equality,
      `{f: v, ...}` rendering. 29 tests. ALL core value types now done.
- [x] `for` loops desugar to higher-order calls (closure builder generalized to
      build from param-names + body; reused by lambdas/local-funs/methods/for). 30 tests.
- [x] Bignum (Phase B) — arbitrary-precision exact ints + rationals in WASM.
- [x] Unified statement compiler (emitStmt) across all block kinds: handles
      let/var/rec, local `fun`, `data`, `when`, `check:`, tests, expressions.
- [x] More pure-Pyret builtins in prelude: not, identity, num-abs/min/max/sqr/
      negate, range, repeat, each, map2, find, get, last, fold. `nothing`,
      `user-block-expr`. Intrinsics: `raise`, `identical`.
- [x] List display as `[list: ...]` (renderer keyed on link/empty ids set at startup).
- [x] **SCOREBOARD: 86/342 (25%) of pyret/lang/tests pass** (scripts/run-corpus.ts).
- [x] `raise`, `print`/`display`, `tostring`/`to-string`, `identical` intrinsics;
      `Option` (some/none) in prelude; `type`/`newtype`/`contract`/`inst` erased.
- [x] `var` + `:=` assignment (local + top-level global mutation).
- [x] `raises` / `does-not-raise` / `satisfies` / `violates` check ops (raises uses
      a host try/catch around an exported thunk-runner — no WASM EH proposal).
- [x] BOOTSTRAP PROBE: real Pyret compiler-source modules now compile with the
      seed — gensym.arr, base.arr, list-aux.arr, libs.arr. 39 seed tests pass.
- [x] Tuples: `{a; b; c}` literals, `.{n}` get, structural eq, `{...; ...}` render
      (reserved variant id 0). `torepr`/`to-repr` intrinsics.
- [x] Module system v1 (seed): `import lib as N` records a compile-time alias;
      `N.foo` / `N.foo(args)` resolve to the (global) builtin. `include`/`import
      from` are no-ops (stdlib already global). mergePrograms now preserves preludes.
      41 tests pass. **Corpus: 130/342 (38%).**
- [x] True multi-module loading (seed): `import file("./x.arr") as N` / `include
      file("./x.arr")` recursively load + inline local modules (whole-program
      compilation; post-order dep resolution, cycle-safe). build.ts buildSourceFile;
      CLI uses it. Verified: cross-file import (35) + include (20). 49 tests. This is
      the dominant corpus blocker AND the prerequisite for compiling Pyret's own
      multi-file compiler.
- [ ] `raw-array-*` low-level builtins; more stdlib (sets, string-dict).
- [x] SELF-HOSTING FOUNDATION PROVEN: `emit-byte` primitive + `num-modulo`/
      `num-quotient` (floor) builtins. A Pyret program compiled by the seed emits a
      valid WASM module (examples/emit-min.arr → f()=42) and computes **LEB128 in
      Pyret** (emit-leb.arr → f()=1000, bytes 0xE8 0x07). 43 tests. This is the
      Pyret-in-WASM → WASM pipeline, no JS in the generation logic.
- [x] WASM encoder in Pyret with AUTOMATIC size computation (LEB128, vectors,
      length-prefixed sections built as byte-lists): examples/wasm-encoder-demo.arr
      builds a valid module → validate=true, f()=7777. 43 tests.
- [x] Reusable encoder API in Pyret (selfhost/encoder-api.arr): functype, vec,
      byte-vec, section, instruction emitters (i32.const/local.get/i32.add/call/end),
      code entries, exports. Builds a 2-function module (add with params + main
      calling add) → validate=true, main()=42, add(20,22)=42. 43 tests.
- [x] Mini COMPILER in Pyret (selfhost/mini-codegen.arr): `data Expr` + recursive
      `compile-expr` (AST -> WASM instruction bytes) + module builder. (3+4)*6 → a
      valid module whose main()=42. The full self-hosting stack in microcosm
      (AST -> codegen -> encoder -> WASM -> runs), all compiled by the seed. 43 tests.
- [x] String builtins: `string-length`, `string-to-code-points` (+ runtime $cons/
      $empty_list building real Pyret lists from WASM).
- [x] **FULL SELF-HOSTING PIPELINE IN MICROCOSM** (selfhost/arith-from-source.arr):
      a compiler written ENTIRELY in Pyret — lexer (string-to-code-points → tokens),
      precedence-climbing recursive-descent parser (→ AST), codegen, and WASM encoder
      — takes SOURCE TEXT to a runnable module. Verified: (3+4)*6=42, 2*3+4*5=26,
      2+3*4-1=13, 100-58=42 (precedence/parens/sub/multi-digit all correct). 44 tests.
      The seed compiles this whole front-end+back-end to WASM; no JS in the pipeline.
- [x] Self-hosted compiler step 2 — VARIABLES/ENVIRONMENTS (selfhost/lang-from-
      source.arr): identifiers resolve to function params via a compile-time env
      (local.get N). main(3,4,6)=42 for "(x+y)*z". 45 tests.
- [x] Self-hosted compiler step 3 — CONTROL FLOW + COMPARISONS + multi-char
      identifiers/keywords (selfhost/lang-if-from-source.arr): `if/then/else/end`,
      `< > ==`, precedence-climbing parser. min(a,b), conditionals verified. 47 tests.
- [x] SEED BUG FIXED: `cases` branch binding that shadows the scrutinee variable
      (and branch-scope leaking to siblings/outer) → was a null-deref; now compile
      scrutinee first + save/restore scope per branch. Improves correctness for ALL
      Pyret programs (regression test added).
- [x] Self-hosted compiler step 4 — LOCAL `let` BINDINGS (`let x = e in body end`):
      allocates WASM locals (let-depth → locals decl) + local.set/local.get; nested
      lets and lets inside `if` verified (49, 30, 16). 47 tests. The Pyret-written
      compiler now does: arithmetic, precedence, parens, vars/params, comparisons,
      if, and local let — a full expression language, from source text, all in Pyret.
- [x] Self-hosted compiler step 5 — FUNCTIONS + CALLS + RECURSION (selfhost/funcs-
      from-source.arr): `fun NAME(params): body end` defs + main expr → multi-function
      WASM module (type/function/export/code sections, `call`). Recursion works:
      sumsq(3,4)=25, fact(5)=120, fib(10)=55. 48 tests. The Pyret-written compiler is
      now a complete (small) functional-language compiler, source→WASM, all in Pyret.
- [x] Self-hosted encoder emits WASM-GC (selfhost/gc-encoder-demo.arr): struct type
      in the type section, `struct.new` (box) + `struct.get` (unbox) via the 0xFB GC
      opcodes. validate=true, boxed/unboxed 42. 50 tests. KEYSTONE for boxed values:
      the Pyret-written encoder can now emit the GC structs Pyret values are made of.
- [x] Self-hosted encoder emits a BOXED-NUMBER RUNTIME (selfhost/boxed-num-demo.arr):
      a $Num box struct + `make-fix` (box i32) + `num-add` (add two boxed values),
      with boxed values passed through function signatures as `(ref $0)`. main boxes
      40 and 2, adds, unboxes -> 42. validate=true. 51 tests. The value model in
      miniature, emitted entirely by the Pyret-written encoder.
- [x] Self-hosted codegen BOXES ALL VALUES through an emitted runtime
      (selfhost/boxed-compiler.arr): every value is a boxed (ref $Num); literals call
      make-fix, operators call num-add/sub/mul (runtime funcs the compiler emits),
      main unboxes. (3+4)*6 fully boxed -> 42. 52 tests. Expression compiler unified
      with the real value model.
- [x] MERGED self-hosted compiler (selfhost/boxed-lang.arr): reads SOURCE TEXT
      (functions/recursion/if/let/comparisons/calls) AND emits fully-boxed-value WASM
      (every value a (ref $Num); literals→make-fix, ops→num-*, cmp→boxed bool, if
      unboxes cond, main unboxes). fact(5)=120, fib(10)=55, nested let=150. 53 tests.
      Structurally the real Pyret compiler (simplified number box + bounded surface).
- [x] Self-hosted box widened to tag + i64 (matching the seed's $Fixnum: a tag
      field for future fixnum/rational/rough dispatch + an i64 value). Covers values
      beyond i32 — fact(20)=2432902008176640000 verified. main returns i64 (JS BigInt).
- [x] Self-hosted runtime TAG-DISPATCH + roughnum (selfhost/tagged-num-demo.arr):
      box=(tag i32, ival i64, fval f64); make-fix/make-rough/to-f64 + a num-add that
      dispatches on tag implementing Pyret's rough CONTAGION (fix+rough=rough).
      num-add(~1.5, 2)=3.5. 54 tests. Second number kind + contagion, all in Pyret.
- [x] Self-hosted RATIONAL kind (selfhost/rational-demo.arr): box (tag, num i64,
      den i64); num-add does EXACT (na*db+nb*da)/(da*db). 1/2 + 1/3 = 5/6. 55 tests.
      All three number kinds now demonstrated in Pyret-emitted runtimes (fix i64,
      rough f64 w/ tag-dispatch+contagion, rational exact) — the seed's $Num tower shape.
- [x] Self-hosted UNIFIED number tower (selfhost/numtower-demo.arr): ONE box (tag,
      num i64, den i64, fval f64) + ONE num-add dispatching over fix/rat/rough —
      exact rationals (1/2+1/3=5/6), fixnums (2+3=5), rough contagion (~1.5+2=3.5).
      56 tests. The complete miniature $Num tower, emitted by the Pyret encoder.
- [x] Self-hosted gcd REDUCTION (selfhost/gcd-rational-demo.arr): Euclid gcd as a
      hand-encoded WASM loop (block/loop/br with correct relative depths) + a
      reducing/sign-normalizing make-rat. 1/2+1/2 = 1/1 (not 4/4); 1/2+1/3 = 5/6.
      57 tests. Exact rational arithmetic now fully correct (i64 range) in Pyret-
      emitted WASM, including loop control flow.
- [x] Self-hosted SOURCE→EXACT-RATIONAL compiler (selfhost/exact-lang.arr): parses
      arithmetic with `/` (exact division) + parens, compiles to the gcd-reducing
      tower. From source: 1/2+1/3=5/6, 6/4=3/2, (1/2)*(2/3)=1/3, 1/2-1/6=1/3, 2+3=5/1.
      58 tests. Exact Pyret number semantics from real syntax, self-hosted.
- [x] Self-hosted CLOSURES (selfhost/closure-demo.arr): function table + element
      segment + closures (struct {funcidx, captured}) + call_indirect. make-adder(n)
      captures n; apply calls indirectly; distinct closures work. =122. 59 tests.
      (signed-LEB i64.const fix.) First-class functions, emitted by the Pyret encoder.
- [x] Self-hosted DATA/CASES (selfhost/data-cases-demo.arr): recursive variant type
      (`data Tree: |leaf |node(v,l,r)`) as a self-referential GC struct in a REC GROUP,
      nullable refs, make-leaf/make-node, recursive `sum` with cases tag-dispatch.
      sum(...) = 12. 60 tests.
- [x] MILESTONE: the Pyret-written encoder now covers EVERY core WASM-emission
      mechanism the real compiler needs — LEB128, sections, functions/calls/recursion,
      control flow (if + loops), locals, GC structs, rec groups (recursive types),
      the full number tower (fix/rat/rough + gcd + contagion), closures + function
      table + call_indirect, and data/variants + cases. All emitted by Pyret→WASM, no JS.
- [x] Self-hosted WASM-GC ARRAYS (selfhost/array-demo.arr): array type, array.new_fixed,
      array.len, array.get + a loop. sum([10,20,30,40])=100. 61 tests. Arrays are the
      foundation for bignum limbs, lists, and strings — the last GC mechanism needed.
- [x] Self-hosted BIGNUM addition (selfhost/bignum-demo.arr): limbs as (array i32)
      base 2^32, multi-limb carry loop (carry in i64). [0xFFFFFFFF,5]+[1,0]=[0,6,0]
      = 6*2^32 (carry across a limb). 62 tests. Whole number tower now self-hostable.
- [x] Self-hosting INTEGRATION (selfhost/exact-funcs.arr): ONE Pyret-written compiler
      with a real front-end (functions/recursion/if/let/comparison/calls, + - * /) AND
      the gcd-reduced exact rational tower. harmonic(3)=11/6, half(3)=3/2, sumto(4)=10/1
      — all from SOURCE TEXT. 63 tests. The two biggest strands now unified.
- [x] Self-hosted bignum COMPARISON (selfhost/bignum-cmp-demo.arr): MSB-down loop,
      unsigned limb compares -> -1/0/1. c-lt=-1, c-gt=1, c-eq=0. 64 tests.
      (Quirk: single-line `fun` helper with deeply-nested-call body hit a parse error
      in the reused parser; inlining worked. Worth investigating later.)
- [x] Self-hosted bignum SUBTRACTION (selfhost/bignum-sub-demo.arr): borrow loop via
      two's-complement wrap (no 2^32 const). [0,1]-[1,0]=2^32-1. 65 tests. Bignum now
      has add/sub/compare; mul remaining.
- [x] Self-hosted bignum MULTIPLY primitive (selfhost/bignum-mul-demo.arr): limb*limb
      -> double-limb via (i64)a*(i64)b split low/high. 1000000^2=10^12. 66 tests. The
      bignum kernel is complete (add/sub/compare/mul-primitive); full nested-loop mul
      builds on it. The number tower is fully self-hostable.
- [x] Self-hosted UNIFORM anyref VALUE MODEL (selfhost/anyref-demo.arr): values flow
      as anyref; numbers boxed (struct i64), booleans i31 (ref.i31); num ops ref.cast,
      comparisons return i31, `if` dispatches via ref.cast i31 + i31.get_s. =30. 67 tests.
      Encodings learned via binaryen disassembly: anyref=0x6E, i31ref=0x6C,
      ref.test=[251,21,ht], ref.cast=[251,23,ht], ref.i31=[251,28], i31.get_s=[251,29].
      This rep lets numbers/bools/variants/lists/strings coexist — foundation for the rest.
- [x] Self-hosted RECURSIVE DATA in anyref model (selfhost/list-anyref-demo.arr):
      cons-list (nil=i31, cons=(struct anyref anyref)) + boxed nums + recursive sum
      with ref.test dispatch. sum([1,2,3])=6. 68 tests. The compiler's own data shape.
- [x] Self-hosted UNIFORM VARIANT rep (selfhost/variant-rep-demo.arr): variant =
      (struct i32 tag, (array anyref) fields); make-variant + vfield. The runtime
      shape for general data/cases (any arity). pair(10,20)->30. 69 tests.
- [x] Self-hosted `cases` TAG DISPATCH (selfhost/cases-rep-demo.arr): vtag + dispatch,
      Option none/some + unwrap-or. Variant runtime complete (make-variant/vfield/vtag/
      dispatch) for general data/cases. 70 tests.
- [ ] Self-hosting next steps: wire a parser for `data`/`cases` source onto the
      uniform variant rep + anyref model (general ADTs from source); reuse Pyret's
      .arr passes; then fixpoint.

## BENCHMARK PROGRESS:
## - [x] Our Pyret→Wasm runs real pitometer programs correctly (e2e test): recursion-
##   triangle-20000=200010001, tail-sum-1000000=500000500000, adding-ones-2000=2000.
## - [x] Bench harness scripts/bench.ts: 2-WAY direct-vs-stoppable(CPS). NUMBERS
##   (best of 5): adding-ones-2000 direct 1.6ms / stop 1.5ms; tail-sum-1000000 direct
##   121.7ms / stop 136.1ms (=1.1× — only ~10% overhead for stoppability! native tail
##   calls mean CPS doesn't trampoline, unlike Stopify's 2-10×); recursion-triangle-
##   20000 direct OVERFLOWS / stop 4.5ms=200010001 (CPS FIXES non-tail deep recursion).
## - [x] CPS STOPPABLE TRANSFORM DONE (Task #1): src/compiler/cps.ts (Danvy one-pass
##   CPS, Pyret→Pyret source), build-stoppable.ts, run-stoppable.ts (single-thread
##   trampoline driver). Infinite loop interrupted on ONE thread via event-loop
##   setTimeout (real stop-button mechanism). 80/0 tests.
## - [x] CPS COVERAGE EXPANDED to full-ish language: fun/if/binop/app/lambda/block-let
##   PLUS [list:]/cases/data/for/dot-field + PRIM-vs-CPS calling-convention split
##   (intrinsics & data constructors called direct; everything else CPS). The stdlib
##   PRELUDE is CPS-transformed with user code, so built-in HOFs (map/filter/foldl/
##   each/range/for) are INTERRUPTIBLE while primitives are not — verified: `each` over
##   range(0,1e8) stopped after 3 pauses on one thread; map/filter/foldl/for/cases/data
##   all match the direct path. Not yet: method calls, check blocks, object methods.
## - [x] "original Pyret" baseline: SOLVED (2026-06-27). Stale checked-in phase0 jarr
##   (add-profiling mismatch) REBUILT into a consistent build/phaseA/pyret.jarr from
##   current src (phase0 can still COMPILE; bunx browserify for the deps-file; cp the
##   generated parser into phaseA/js). Run with NODE (nvm v24; bun rejects the
##   standalone's dup `_` params). Reproducible: scripts/bench-pyret-baseline.sh. See
##   memory original-pyret-baseline for the exact rebuild recipe.
## - [x] THREE-WAY BENCHMARK (the finish-line deliverable). Per-program:
##   adding-ones-2000:  origPyret ~5ms  | direct-wasm 1.6ms | stoppable-wasm 1.5ms
##   recursion-triangle-20000: origPyret ~12ms | direct-wasm OVERFLOW | stoppable 4.5ms
##   tail-sum-1000000:  origPyret ~78ms | direct-wasm 122ms  | stoppable-wasm 137ms
##   (origPyret = node standalone total minus ~170ms node+runtime startup; wasm = best
##   of 5 run, includes instantiate.) HONEST takeaways: (1) stoppability costs only
##   ~1.1× (native tail calls => no trampoline, vs Stopify 2-10×); (2) wasm beats orig
##   Pyret on the small/short programs; (3) orig Pyret wins tail-sum because js-numbers
##   keeps sums <2^53 UNBOXED while our wasm boxes a $Fixnum per step (optimization
##   opportunity: unboxed i64 fast path); (4) CPS lets wasm run deep non-tail recursion
##   that overflows the direct path (orig Pyret handles it via its own Stopify trampoline).

## FINISH LINE (user, 2026-06-26): conclude ONLY when the IDE is fully ready AND
## benchmark numbers are shown for THREE configs: Pyret→Wasm, stoppable Pyret→Wasm,
## and original Pyret. Benchmark suite EXISTS: pyret/lang/pitometer/programs/*.arr
## (recursion-triangle, tail-sum, adding-ones, recursive-calls, inner-function,
## bignum-factorial, method-calls, many-links, list-set, mutable-string-dict, ast,
## anf-loop-compiler, …). Original Pyret runs via pyret/lang/build/phase0 (Node).
## Pick the programs our compiler supports first (recursion/arith/tail-sum), grow coverage.

## STOPPABLE CODEGEN (Stopify-for-WASM) — REQUIRED before the IDE (see requirement 6)

The IDE runs user code on the UI thread (NO Web Worker). So compiled user code must
suspend/yield to JS several times/sec and be resumable. PLAN (user-specified, 2026-06-26):
- DON'T modify the main Pyret→WASM self-hosted compiler. Instead write a SEPARATE
  **Pyret→Pyret source-to-source pass** that inserts a `yield-check()` at the TOP of
  every function body and loop body. Compose: stoppable-transform ∘ normal-compiler.
- MECHANISM = CPS (JSPI not widely supported). The pass is a continuation-passing
  transform; yield points return the continuation to a tiny JS driver/trampoline that
  yields to the event loop (Stop handler sets a flag) then resumes via the cont, or
  aborts. Relies on the compiler's NATIVE proper tail calls (return_call) so CPS's
  pervasive tail calls don't overflow — no JS trampoline-per-call needed like Stopify.
- Built-in HOFs (map/each/foldl/filter/…) are Pyret-written → the transform covers
  them, so they're interruptible. Do NOT instrument primitives (bignum ops, etc.) —
  bounded. Apply the transform only to USER code (+ the Pyret stdlib), not the compiler.
- JS is required and OK here (minimal: the yield/resume driver + stop flag).
- Remove worker.terminate() (web/worker.ts) — superseded by this.
- [ ] Self-hosting (DECIDED): compiler emits **WASM directly, never JS**. Replace
      `js-of-pyret.arr` with a `wasm-of-pyret` pass written in Pyret + a **WASM-GC
      binary encoder in Pyret** (binaryen's role for the seed). Pipeline stays pure
      Pyret→WASM; JS only for host glue. (see bootstrap-strategy memory)
- [x] IDE upgraded to CPO style: CodeMirror + CPO's Pyret mode (vendored), two-pane
      Definitions/Interactions, **REPL prompt** (evaluates in context of defs),
      run/stop, error messages. Verified headless (scripts/ide-test.ts, 6/6 checks).
- [ ] IDE remaining: images library, rich value/table rendering, multi-file,
      spy output, closer CPO styling.
- [ ] List display as `[list: ...]` (currently link/empty form).
- [ ] Stop button (worker.terminate on web; gas-check interrupt for CLI).
- [x] **Bignum (Phase B): arbitrary-precision exact integers IN WASM.** $Bignum
      ($Num subtype: sign + i32-limb magnitude array) + $Limbs. Magnitude ops
      (cmp/add/sub/mul/normalize/divmod-small) and signed add/sub/mul/cmp, all in
      binaryen IR. Integer +,-,* route through it with i64 overflow promotion and
      demotion back to Fixnum when small. Decimal render via repeated /10. Large
      literals build $Bignum directly. Verified factorial(100) == Python (158
      digits), overflow, negatives, equality/compare. 32 tests.
- [x] **Full arbitrary-precision number tower.** $Rational now holds integer
      $Num num/den (Fixnum or Bignum), gcd-reduced. General bignum division
      (binary long division `$mag_divmod`) + Euclid `$mag_gcd`. `make_rat` reduces
      via bignum gcd. All exact +,-,*,/ and compare/equal route through bignum
      ops over $Num components. Verified: `1/10000000000000000000000`,
      `bignum + 1/2 = …001/2`, `big/big → 1/2`, `f(30)/f(28) = 870`. 33 tests.
      Fixed two binaryen footguns: shared expr nodes across functions (alias);
      `i32.and` is not short-circuit so guard casts with `if`.
- [ ] Roughnum printing (Ryu) — currently prints "roughnum". num-modulo/floor builtins.
- [ ] Re-enable optimizer (curated passes; default opt emits GC types JSC rejects).
- [ ] Test harness over pyret/lang/tests (scoreboard).
- [ ] Self-host in Pyret. Web IDE.

## Known gotchas (binaryen v130 / JSC)

- `i64.const` takes a single bigint (not low/high).
- `br_if` with a value can't be a non-final block element; break via `if`+`br`.
- Memory must be set before adding functions that reference it.
- `m.optimize()` (default O2) emits a GC type encoding JSC rejects at parse —
  keep it off until a safe pass list is found.
- `binaryen.Features.All` enables CustomDescriptors (bit 21), which makes binaryen
  emit **exact reference types** (`(ref (exact $t))`) that JSC/browsers reject
  ("can't get heap type for ref.cast"). Always use `FEATURES` from types.ts
  (= All & ~(1<<21)). This matters for the browser target too.
