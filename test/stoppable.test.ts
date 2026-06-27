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

// ---- (b) the stop button: a long/infinite computation is abandoned on ONE thread ----

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
