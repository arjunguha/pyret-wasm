import { test, expect } from "bun:test";
import { resolve } from "path";
import { buildStoppableSource, buildStoppableSourceFile } from "../src/build-stoppable.ts";
import { runStoppable } from "../src/runtime/run-stoppable.ts";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

const PIT = resolve(import.meta.dir, "../pyret/lang/pitometer/programs");

async function evalStoppable(src: string): Promise<string> {
  const wasm = await buildStoppableSource(src);
  const r = await runStoppable(wasm, { noYield: true }).promise;
  if (r.error) throw new Error(r.error);
  return r.output.trimEnd();
}

// ---- (a) correctness through the CPS pipeline ----

test("stoppable: arithmetic and tail recursion", async () => {
  expect(await evalStoppable("1 + 1 + 1 + 1")).toBe("4");
  expect(await evalStoppable(
    "fun sum(n, sofar): if n <= 0: sofar else: sum(n - 1, sofar + n) end end\nsum(10, 0)")).toBe("55");
});

test("stoppable: non-tail recursion (factorial, triangle)", async () => {
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

test("stoppable: runs real pitometer programs correctly", async () => {
  const cases: [string, string][] = [
    ["adding-ones-2000", "2000"],
    ["recursion-triangle-20000", "200010001"], // non-tail depth 20k: CPS -> tail calls, no overflow
    ["tail-sum-1000000", "500000500000"],
  ];
  for (const [name, expected] of cases) {
    const wasm = await buildStoppableSourceFile(resolve(PIT, name + ".arr"));
    const r = await runStoppable(wasm, { noYield: true }).promise;
    expect(r.error).toBeUndefined();
    expect(r.output.trim()).toBe(expected);
  }
}, 60000);

// ---- (a2) stdlib coverage: lists / cases / data / for, cross-checked vs the
//          DIRECT (non-stoppable) compiler to confirm CPS preserves semantics ----

test("stoppable: stdlib HOFs and data forms match the direct path", async () => {
  const progs = [
    "map(lam(x): x + 1 end, [list: 1, 2, 3, 4, 5]) ^ sum",
    "filter(lam(x): x > 2 end, [list: 1, 2, 3, 4, 5])",
    "foldl(lam(a, b): a + b end, 0, [list: 1, 2, 3, 4, 5])",
    "sum(range(0, 10))",
    "for foldl(acc from 0, e from [list: 10, 20, 30]): acc + e end",
    "sum(map2(lam(a, b): a * b end, [list: 1, 2, 3], [list: 4, 5, 6]))",
    "fun len(l): cases(List) l: | empty => 0 | link(f, r) => 1 + len(r) end end\nlen([list: 7, 7, 7, 7])",
    "data Tree: | leaf | node(v, l, r) end\n" +
      "fun tsum(t): cases(Tree) t: | leaf => 0 | node(v, l, r) => v + tsum(l) + tsum(r) end end\n" +
      "tsum(node(5, node(3, leaf, leaf), leaf))",
  ];
  for (const src of progs) {
    // some use `^` (reverse application) — rewrite to plain application for both paths
    const s = src.replace("map(lam(x): x + 1 end, [list: 1, 2, 3, 4, 5]) ^ sum",
      "sum(map(lam(x): x + 1 end, [list: 1, 2, 3, 4, 5]))");
    const direct = (await run(await buildSource(s))).output.trim();
    const stoppable = (await runStoppable(await buildStoppableSource(s), { noYield: true }).promise).output.trim();
    expect(stoppable).toBe(direct);
  }
}, 30000);

// ---- (b) interruption on a single thread (no Web Worker) ----

test("stoppable: a built-in higher-order function (each) is interruptible", async () => {
  // each/range over an enormous list never completes; we stop it after a few
  // pauses on a single thread. Proves the Pyret-written HOF yields (the user's
  // headline requirement) — while primitives are not instrumented.
  const wasm = await buildStoppableSource("each(lam(x): x end, range(0, 100000000))");
  const h = runStoppable(wasm, { noYield: true, onPause: (n) => { if (n >= 3) h.stop(); } });
  const r = await h.promise;
  expect(r.stopped).toBe(true);
  expect(r.pauses).toBeGreaterThanOrEqual(3);
}, 20000);


test("stoppable: an infinite loop can be stopped (via onPause)", async () => {
  const wasm = await buildStoppableSource("fun loop(n): loop(n + 1) end\nloop(0)");
  const h = runStoppable(wasm, { onPause: (n) => { if (n >= 3) h.stop(); } });
  const r = await h.promise;
  expect(r.stopped).toBe(true);
  expect(r.pauses).toBeGreaterThanOrEqual(3);
}, 20000);

test("stoppable: infinite loop stopped by an event-loop timer (UI-thread Stop button)", async () => {
  // Proves single-thread interruptibility: the compiled loop yields to the JS
  // event loop, where a timer (standing in for a Stop click) runs on the SAME
  // thread, sets the flag, and the computation terminates.
  const wasm = await buildStoppableSource("fun loop(n): loop(n + 1) end\nloop(0)");
  const h = runStoppable(wasm); // default: yields to the event loop between resumes
  const timer = setTimeout(() => h.stop(), 10);
  const r = await h.promise;
  clearTimeout(timer);
  expect(r.stopped).toBe(true);
  expect(r.pauses).toBeGreaterThanOrEqual(1);
}, 20000);
