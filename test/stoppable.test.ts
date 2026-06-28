// The STOPPABLE pipeline: user code is run through the Pyret->Pyret CPS transform
// (self-host/cps.arr, executed via the seed-compiled cps-driver.arr) and compiled
// with the seed's {stoppable:true} codegen, then run under the single-thread
// trampoline driver (run-stoppable.ts). Stoppability lives in the Pyret transform,
// NOT the TS seed (cps.ts was deleted). This verifies (a) the CPS pipeline computes
// correctly and (b) a long/infinite computation can be STOPPED on one thread.
import { test, expect } from "bun:test";
import { buildStoppableSource } from "../src/build-stoppable.ts";
import { runStoppable } from "../src/runtime/run-stoppable.ts";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";
import { runSourceSelfHosted } from "../src/build-selfhosted.ts";

async function evalStoppable(src: string): Promise<string> {
  const wasm = await buildStoppableSource(src);
  const r = await runStoppable(wasm, { noYield: true }).promise;
  if (r.error) throw new Error(r.error);
  return r.output.trimEnd();
}

async function evalDirect(src: string): Promise<string> {
  const r = await run(await buildSource(src));
  if (r.error) throw new Error(r.error);
  return r.output.trimEnd();
}

// ---- CPS reference = COMPILER #2 (the self-hosted compiler compiled by the seed) ----
// Per the project's three-compiler model: (1) the TS seed is bootstrap ONLY — not a
// reference; (2) the self-hosted compiler compiled BY the seed (`runSourceSelfHosted`)
// is the CPS correctness reference; (3) the fixpoint compiler ships on the web. So the
// CPS transform should preserve meaning as judged by COMPILER #2, not the seed.
//
// Scope of this oracle TODAY: compiler #2 compiles a SINGLE source program (the driver
// injects only a minimal List), so it can't run the FREE prelude HOFs (map/foldl/range —
// they need the prelude inlined, which the stoppable path does but a bare oracle program
// doesn't); those stay direct-referenced below. Compiler #2 also doesn't echo top-level
// values, so oracle programs are `print`-wrapped. run-stoppable displays a trailing
// top-level `nothing`, stripped before comparing.
async function evalSelfHosted(src: string): Promise<string> {
  return (await runSourceSelfHosted(src)).trimEnd();
}
function stripNothing(s: string): string {
  return s.split("\n").filter((l) => l !== "nothing").join("\n").trimEnd();
}
// Each program ends in `nothing` so the top-level result is nothing (stripped on both
// sides): run-stoppable echoes the top-level value but compiler #2 doesn't, so without
// this `print(4)` would give stoppable "4\n4" vs compiler #2 "4". The `print(...)` is
// the actual observable both must agree on.
test("stoppable: matches COMPILER #2 (self-hosted reference) on core constructs", async () => {
  for (const src of [
    "print(1 + 1 + 1 + 1)\nnothing",                                                       // arithmetic
    "fun sm(n, s): if n <= 0: s else: sm(n - 1, s + n) end end\nprint(sm(10, 0))\nnothing", // recursion
    "fun app(f, x): f(x) end\nprint(app(lam(n): n + 1 end, 41))\nnothing",                  // lambda / HOF
    "fun f(n): a = n + 1\n b = a * 2\n b end\nprint(f(10))\nnothing",                        // let-block
    "data D: | mt | nd(v) end\nprint(cases(D) nd(7): | mt => 0 | nd(v) => v end)\nnothing", // data + cases
    "print([list: 1, 2, 3].length())\nnothing",                                             // list method
    "print(if 3 > 1: 100 else: 200 end)\nnothing",                                          // if/else
  ]) {
    expect(stripNothing(await evalStoppable(src)), src).toBe(stripNothing(await evalSelfHosted(src)));
  }
}, 180000);
test("stoppable: check block matches COMPILER #2 (self-hosted reference)", async () => {
  const src = "check: 2 + 3 is 5 end";
  expect(stripNothing(await evalStoppable(src))).toBe(stripNothing(await evalSelfHosted(src)));
}, 60000);

// ---- (a) correctness through the CPS pipeline (direct/seed cross-check) ----
// NOTE: the prelude-HOF / operator-method tests below stay referenced to the SEED
// (`evalDirect`) because compiler #2 can't run free prelude HOFs as a bare program yet
// (no prelude inlining) — see the compiler-#2 oracle note above.

test("stoppable: arithmetic", async () => {
  expect(await evalStoppable("1 + 1 + 1 + 1")).toBe("4");
});

test("stoppable: tail recursion", async () => {
  expect(await evalStoppable(
    "fun sum(n, sofar): if n <= 0: sofar else: sum(n - 1, sofar + n) end end\nsum(10, 0)")).toBe("55");
});

test("stoppable: non-tail recursion (CPS -> tail calls, no overflow)", async () => {
  expect(await evalStoppable(
    "fun fact(n): if n <= 0: 1 else: n * fact(n - 1) end end\nfact(5)")).toBe("120");
  expect(await evalStoppable(
    "fun tri(n): if n <= 0: 0 else: n + tri(n - 1) end end\ntri(100)")).toBe("5050");
});

test("stoppable: lambda and higher-order call", async () => {
  expect(await evalStoppable(
    "fun app(f, x): f(x) end\nfun inc(n): n + 1 end\napp(inc, 41)")).toBe("42");
  expect(await evalStoppable(
    "fun twice(f, x): f(f(x)) end\ntwice(lam(n): n * n end, 3)")).toBe("81");
});

test("stoppable: block with let-bindings", async () => {
  expect(await evalStoppable(
    "fun f(n): a = n + 1\n b = a * 2\n b end\nf(10)")).toBe("22");
});

// CPS must preserve semantics: cross-check against the direct (non-stoppable) path.
test("stoppable: matches the direct compiler", async () => {
  for (const src of [
    "fun gcd(a, b): if b == 0: a else: gcd(b, a - (b * (a / b))) end end\ngcd(48, 36)",
    "fun pow(b, e): if e <= 0: 1 else: b * pow(b, e - 1) end end\npow(2, 10)",
  ]) {
    expect(await evalStoppable(src)).toBe(await evalDirect(src));
  }
});

// Regression: a NON-LAST statement's side effects (e.g. print) must run, in order.
// Previously the non-last expression continuation discarded its value, dropping the
// emitted call entirely → only the final value showed.
test("stoppable: non-last statement side effects (print) run in order", async () => {
  for (const src of [
    'print("a")\nprint("b")\n5',
    'print("hi")\nnothing',
    'print(1)\nprint(2)\nprint(3)',
  ]) {
    expect(await evalStoppable(src)).toBe(await evalDirect(src));
  }
});

// The prelude is CPS-transformed TOGETHER with user code, so built-in higher-order
// functions are themselves interruptible. Verify they still compute correctly through
// the CPS pipeline (parity with the direct compiler).
test("stoppable: prelude HOFs match the direct compiler", async () => {
  for (const src of [
    "foldl(lam(acc, x): acc + x end, 0, [list: 1, 2, 3, 4, 5])",
    "sum(map(lam(x): x * x end, [list: 1, 2, 3]))",
    "length(filter(lam(x): x > 2 end, [list: 1, 2, 3, 4]))",
    "sum(range(0, 5))",
    "for fold(acc from 0, x from range(1, 6)): acc + x end",
    "each(lam(x): print(x) end, [list: 7, 8, 9])",
  ]) {
    expect(await evalStoppable(src)).toBe(await evalDirect(src));
  }
});

// Data METHODS survive the CPS transform: the `with:`/`sharing:` blocks are
// CPS-transformed (each method takes a trailing continuation), so NAMED method calls
// on built-in data (List, ...) work in stoppable mode. Operator methods (list `+`
// via `_plus`) remain seed-blocked (fixed-arity operator dispatch). Parity with direct.
test("stoppable: data methods (.map/.length/.foldl/...) match the direct compiler", async () => {
  for (const src of [
    "[list: 1, 2, 3].length()",
    "sum([list: 1, 2, 3].map(lam(x): x + 1 end))",
    "length([list: 1, 2, 3, 4].filter(lam(x): x > 2 end))",
    "[list: 1, 2, 3].foldl(lam(acc, x): acc + x end, 0)",
    "sum([list: 3, 2, 1].reverse())",
  ]) {
    expect(await evalStoppable(src)).toBe(await evalDirect(src));
  }
});

// OPERATOR methods (list/data `+` -> `_plus`, etc.) are routed through the `cps-op-*`
// intrinsic, so they're dispatched WITH a continuation and match the direct compiler.
// (Numeric/string `+`/`<` stay a direct fast-path — covered by the arithmetic tests.)
test("stoppable: operator methods (list +, chains) match the direct compiler", async () => {
  for (const src of [
    "tostring([list: 1, 2] + [list: 3, 4])",
    "tostring([list: 1] + [list: 2] + [list: 3])",
    "length([list: 1, 2] + [list: 3, 4, 5])",
    "tostring([list: 1, 2] + empty)",
    'string-append("a", "b") + "c"',
  ]) {
    expect(await evalStoppable(src)).toBe(await evalDirect(src));
  }
});

// An operator method (`_plus`) driving a long stdlib loop stays interruptible — the
// only way to pause is inside the CPS'd `_plus`/`append`, proving operator methods
// thread the continuation.
test("stoppable: an operator-method loop (repeated list +) can be STOPPED", async () => {
  const h = runStoppable(
    await buildStoppableSource(
      "foldl(lam(acc, x): acc + [list: x] end, empty, range(0, 20000))"),
    { onPause: (n) => { if (n >= 2) h.stop(); } },
  );
  const r = await h.promise;
  expect(r.stopped).toBe(true);
  expect(r.pauses).toBeGreaterThanOrEqual(2);
});

// A data method that internally drives a stdlib loop stays interruptible.
test("stoppable: a data method (.map over a large range) can be STOPPED", async () => {
  const h = runStoppable(
    await buildStoppableSource("range(0, 300000).map(lam(x): x end)"),
    { onPause: (n) => { if (n >= 2) h.stop(); } },
  );
  const r = await h.promise;
  expect(r.stopped).toBe(true);
  expect(r.pauses).toBeGreaterThanOrEqual(2);
});

// ---- (b) the stop button: a long/infinite computation is abandoned on ONE thread ----

// The decisive proof that prelude HOFs are interruptible: the ONLY looping here is
// inside the stdlib `range`/`each` (no user recursion), yet it can still be stopped.
test("stoppable: a prelude HOF (each over a large range) can be STOPPED", async () => {
  const h = runStoppable(
    await buildStoppableSource("each(lam(x): x end, range(0, 300000))"),
    { onPause: (n) => { if (n >= 2) h.stop(); } },
  );
  const r = await h.promise;
  expect(r.stopped).toBe(true);
  expect(r.pauses).toBeGreaterThanOrEqual(2);
});

test("stoppable: an infinite loop can be STOPPED", async () => {
  const h = runStoppable(
    await buildStoppableSource("fun loop(n): loop(n + 1) end\nloop(0)"),
    { onPause: (n) => { if (n >= 2) h.stop(); } },
  );
  const r = await h.promise;
  expect(r.stopped).toBe(true);
  expect(r.pauses).toBeGreaterThanOrEqual(2);
});

test("stoppable: a normal program is NOT reported stopped", async () => {
  const r = await runStoppable(
    await buildStoppableSource("fun sq(n): n * n end\nsq(9)"),
    { noYield: true },
  ).promise;
  expect(r.stopped).toBe(false);
  expect(r.output.trim()).toBe("81");
});

// ---- check: blocks (CPS-transformed) ----
// The CPS transform handles `check:` blocks by CPS-evaluating each test's operands to
// values (so calls inside stay interruptible) then comparing them in a check block — so
// the seed's check harness records pass/fail + renders messages exactly as the direct
// compiler. Only equality-comparison ops (is / is-not / is-roughly / ...) are supported;
// satisfies/is%/raises call a user predicate/thunk that, post-CPS, takes a continuation
// the harness can't supply.
// NOTE: run-stoppable displays the top-level `nothing` result (the seed's run() suppresses
// it), so we strip standalone "nothing" lines before comparing the check-harness output.
async function checkAgrees(src: string): Promise<void> {
  const seedOut = (await run(await buildSource(src))).output.trimEnd();
  const stopRaw = (await runStoppable(await buildStoppableSource(src), { noYield: true }).promise).output.trimEnd();
  const stopOut = stopRaw.split("\n").filter((l) => l !== "nothing").join("\n");
  expect(stopOut, `check output for ${JSON.stringify(src)}`).toBe(seedOut);
}

test("stoppable: check block (passing) matches the seed", async () => {
  await checkAgrees("check: 2 + 3 is 5 end");
});
test("stoppable: check block (failing) matches the seed", async () => {
  await checkAgrees("check: 2 + 3 is 6 end");
});
test("stoppable: named check block, mixed pass/fail + is-not, matches the seed", async () => {
  await checkAgrees('check "nm": 1 is 1\n  2 is-not 2\n  3 is 3 end');
});
test("stoppable: check with interruptible call in a test operand matches the seed", async () => {
  await checkAgrees("fun f(x): x + 1 end\ncheck: f(4) is 5 end");
});

// ---- (c) per-construct coverage net (prerequisite for the cps.arr -> ast.arr migration) ----
// Each program exercises a distinct construct cps-transform handles; the stoppable/CPS result
// must MATCH the direct (non-stoppable) compiler. A future cps.arr rewrite that mis-handles any
// construct fails the matching assertion loudly. Each program is small + single-construct.
async function same(src: string): Promise<void> {
  expect(await evalStoppable(src), `stoppable vs direct for ${JSON.stringify(src)}`)
    .toBe(await evalDirect(src));
}

const CONSTRUCTS: Array<[string, string]> = [
  ["if / else-if (if-expr)", "fun c(n): if n < 0: 0 - 1 else if n == 0: 0 else: 1 end end\nc(5) + c(0 - 3) + c(0)"],
  ["ask: (if-pipe-expr)", "x = 5\nask: | x > 10 then: 1 | x > 0 then: 2 | otherwise: 3 end"],
  ["for loop (for-expr)", "for fold(acc from 0, n from [list: 1, 2, 3, 4]): acc + n end"],
  ["cases over data (cases-expr)", "data Sh: | circ(r) | sq(s) end\nfun area(x): cases(Sh) x: | circ(r) => r * r | sq(s) => s * s end end\narea(circ(3)) + area(sq(2))"],
  ["cases with else branch", "cases(List) [list: 1]: | empty => 0 | else => 99 end"],
  ["tuple + tuple-get (tuple-expr)", "t = {3; 4}\nt.{0} + t.{1}"],
  ["object literal + dot (obj-expr/dot-expr)", "o = {a: 1, b: 2}\no.a + o.b"],
  ["and / or (pure operands)", "if ((true and false) or (2 > 1)): 1 else: 0 end"],
  ["comparisons (< <= > >= ==)", "if (1 < 2) and (2 <= 2) and (5 >= 5) and (6 == 6) and not(3 > 4): 1 else: 0 end"],
  ["exact fraction literal (frac-expr)", "(1/2) + (1/3)"],
  ["roughnum literal + contagion (rfrac/num)", "~1.5 + ~2.0"],
  ["string literal + concat (string-expr)", '"ab" + "cd"'],
  ["user block (block: ... end)", "block:\n  x = 1\n  x + 1\nend"],
  ["paren-expr", "(1 + 2) * 3"],
  ["nested closures (capture)", "fun mk(n): lam(m): lam(p): n + (m + p) end end end\nmk(1)(2)(3)"],
  ["mutual recursion", "fun ev(n): if n == 0: true else: od(n - 1) end end\nfun od(n): if n == 0: false else: ev(n - 1) end end\nif ev(10): 1 else: 0 end"],
  ["method call on object (self)", "o = { v: 5, method get(self): self.v end }\no.get()"],
];

for (const [label, src] of CONSTRUCTS) {
  test(`stoppable construct: ${label} matches the direct compiler`, async () => {
    await same(src);
  });
}

// Interruptibility through a `for` loop (complements the each/operator/data-method stop tests).
test("stoppable: a for-loop over a large range can be STOPPED", async () => {
  const h = runStoppable(
    await buildStoppableSource("for each(n from range(0, 100000000)): n end"),
    { onPause: (n) => { if (n >= 2) h.stop(); } },
  );
  const r = await h.promise;
  expect(r.stopped).toBe(true);
  expect(r.pauses).toBeGreaterThanOrEqual(2);
});

// `when` is lowered to `if` by the CPS transform, so the STOPPABLE path supports it even
// though the SEED's direct compiler does NOT (CompileError: unsupported expression: when-expr).
// So assert against an expected value, not the direct compiler.
test("stoppable construct: when (when-expr, cps-lowered to if; seed lacks when-expr)", async () => {
  expect(await evalStoppable("x = 5\nwhen x > 0: nothing end\nx")).toBe("5");
  expect(await evalStoppable("when 1 > 2: nothing end\n42")).toBe("42");
});

// ---- documented cps.arr GAPS (surfaced while building this net) ----
// These constructs are NOT handled by cps-transform today; skipped so the net stays GREEN.
// The cps.arr -> ast.arr migration should IMPLEMENT them and un-skip — and must not silently
// regress the (c) construct net above.
test.skip("GAP cps.arr: assign-expr (:=) — 'unsupported expression in CPS: assign-expr'", async () => {
  await same("var c = 0\nc := c + 10\nc");
});
test.skip("GAP cps.arr: multi-let-expr — 'unsupported expression in CPS: multi-let-expr'", async () => {
  await same("let a = 1, b = a + 1: a + b end");
});
test.skip("GAP cps.arr: and/or do NOT short-circuit (effectful RHS is evaluated -> traps)", async () => {
  await same("if (false and ((1 / 0) == 0)): 9 else: 2 end");
});
