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

// ---- (a) correctness through the CPS pipeline ----

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
