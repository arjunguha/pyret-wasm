// The THIRD compiler: the Pyret->Pyret CPS transform (self-host/cps.arr) that makes
// programs cooperatively STOPPABLE. It is written in Pyret (NOT in the TS seed) and
// is itself compiled to WASM by the seed. Stoppability lives ONLY here.
//
// This exercises `cps-transform` end-to-end: a seed-compiled program (fixtures/cps-demo.arr)
// hand-builds CstNodes and prints the emitted (stoppable) source. We assert the
// transform's strategy is applied — a continuation param is threaded, function entry
// is wrapped in a yield-check (the cooperative stop point), and general calls become
// tail calls that pass the continuation along (constant-space tail recursion).
import { test, expect } from "bun:test";
import { resolve } from "path";
import { buildSourceFile } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

const FIXTURE = resolve(import.meta.dir, "fixtures/cps-demo.arr");

async function runFixture(): Promise<string> {
  const wasm = await buildSourceFile(FIXTURE);
  return (await run(wasm)).output;
}

// Pull the transform output for one delimited section out of the fixture's stdout.
function section(out: string, tag: string): string {
  const m = out.match(new RegExp(`===${tag}===\\n([\\s\\S]*?)===`));
  return (m ? m[1] : "").trim();
}

test("cps-transform: function entry gets a yield-check + threaded continuation", async () => {
  const out = await runFixture();
  const p1 = section(out, "P1");
  // fun f(n): g(n) end  ==>  the body is wrapped in a yield-check (the stop point)...
  expect(p1).toContain("yield-check(lam():");
  // ...an extra continuation parameter is threaded into the function...
  expect(p1).toMatch(/fun f\(n, kcps\d+\):/);
  // ...and the general (non-primitive) call becomes a tail call passing it along.
  expect(p1).toMatch(/g\(n, kcps\d+\)/);
});

test("cps-transform: a bare value is fed to the final continuation", async () => {
  const out = await runFixture();
  // 5  ==>  finish-result(5)  (the top-level driver's terminal continuation)
  expect(section(out, "P2")).toBe("finish-result(5)");
});

test("cps-transform: cases keeps its else-branch (was dropped by the stub)", async () => {
  const p3 = section(await runFixture(), "P3");
  // cases(List) x: | empty => 1 | else => 2 end  ==>  scrutinee + BOTH branches,
  // each feeding the (once-bound) continuation; the else-branch must survive.
  expect(p3).toContain("cases(List) x:");
  expect(p3).toContain("| empty =>");
  expect(p3).toMatch(/\| else => kcps\d+\(2\)/);
});

test("cps-transform: when lowers to if + nothing, body stays interruptible", async () => {
  const p4 = section(await runFixture(), "P4");
  // when x: g(x) end  ==>  if x: <g CPS-called> else: <nothing> end ; value is nothing
  expect(p4).toContain("if x:");
  expect(p4).toMatch(/g\(x, lam\(vcps\d+\): kcps\d+\(nothing\) end\)/); // body CPS-threaded
  expect(p4).toMatch(/else: kcps\d+\(nothing\) end/);                   // else yields nothing
});

test("cps-transform: ask lowers to a nested if, threading the continuation", async () => {
  const p5 = section(await runFixture(), "P5");
  // ask: | x then: 1 | otherwise: 2 end  ==>  if x: k(1) else: k(2) end
  expect(p5).toMatch(/if x: kcps\d+\(1\) else: kcps\d+\(2\) end/);
});
