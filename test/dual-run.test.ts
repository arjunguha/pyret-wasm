// TRI-RUN MATRIX — every supported program must compile+run through ALL THREE
// compilers and AGREE on the computed value:
//   (1) the SEED compiler (src/build.ts),
//   (2) the SELF-HOSTED compiler (self-host/compile-driver.arr, via build-selfhosted.ts),
//   (3) the STOPPABLE/CPS compiler (build-stoppable.ts: the Pyret->Pyret CPS transform
//       composed before the main compiler; run on the single-thread trampoline).
// This is the growing regression net proving the three compilers are equivalent as
// coverage rises (the path to the fixpoint + the deployable stoppable artifact).
//
// HOW agreement is checked WITHOUT relying on stdout: the self-hosted compiler runs
// a program's top-level expression but does NOT yet print its result (the seed does).
// So we can't compare stdout. Instead we use the TRAP-ON-WRONG-VALUE technique (same
// idea as test/selfhost-e2e.test.ts): wrap each program as
//     if (EXPR) == EXPECTED: 0 else: 1 / 0 end
// which runs WITHOUT error iff the compiler computed EXPR == EXPECTED. Running the
// wrapped program through ALL THREE compilers and asserting none errors proves they
// agree on the value. A negative-control test confirms a wrong EXPECTED makes ALL
// THREE fail (so the harness actually has teeth). We also assert the seed's own
// output for the bare EXPR equals EXPECTED, which pins EXPECTED to the true value.
//
// To PROMOTE a program into the matrix: every compiler must handle it. Per-compiler
// PENDING lists below track what each can't do yet (one line per program).

import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { buildSourceSelfHosted } from "../src/build-selfhosted.ts";
import { buildStoppableSource } from "../src/build-stoppable.ts";
import { run } from "../src/runtime/run.ts";
import { runStoppable } from "../src/runtime/run-stoppable.ts";

// "ok" iff the program compiles AND runs with no error under the given compiler.
async function seedOutcome(src: string): Promise<"ok" | "fail"> {
  try { return (await run(await buildSource(src))).error ? "fail" : "ok"; }
  catch { return "fail"; }
}
async function selfHostedOutcome(src: string): Promise<"ok" | "fail"> {
  try { return (await run(await buildSourceSelfHosted(src))).error ? "fail" : "ok"; }
  catch { return "fail"; }
}
async function stoppableOutcome(src: string): Promise<"ok" | "fail"> {
  // run to completion on the trampoline; noYield = don't await the event loop between
  // resumes (faster, still correct for finite programs).
  try {
    const r = await runStoppable(await buildStoppableSource(src), { noYield: true }).promise;
    return r.error ? "fail" : "ok";
  } catch { return "fail"; }
}

// [expression, expected-value-as-Pyret-source]. All currently yield numbers.
// Every entry compiles+runs+agrees under ALL THREE compilers (verified below).
const MATRIX: [string, string][] = [
  ["2 + 3", "5"],
  ["10 - 4", "6"],
  ["(1 + 2) * 3", "9"],
  ["(3 * 3) + (4 * 4)", "25"], // Pyret has no operator precedence — parens required for mixed ops
  ["if true: 1 else: 2 end", "1"],
  ["if false: 1 else: 2 end", "2"],
  ["if (3 > 1): 100 else: 200 end", "100"],
  ["if (2 > 5): 100 else: 200 end", "200"],
  ["block: fun f(x): x + 1 end\n f(5) end", "6"],
  ["block: fun id(x): x end\n id(42) end", "42"],
  ["block: fun sq(x): x * x end\n sq(9) end", "81"],
  ["(lam(x): x + 2 end)(8)", "10"],
  ["{a: 3, b: 4}.b", "4"],
  ["[list: 1, 2, 3].length()", "3"], // injected-List methods now compile self-hosted
  ["(_ + 1)(4)", "5"],               // _-curry now desugars self-hosted
];

// Per-compiler PENDING — programs a given compiler can't handle YET. Promote into
// MATRIX once ALL THREE handle it. (The seed handles all of these today.)
//   self-hosted: needs data/cases-in-anf, prelude inclusion (lists/print), check-in-anf.
//   stoppable:   handles check: now (see test/stoppable.test.ts); nothing pending.
const PENDING_SELF_HOSTED: [string, string][] = [
  // num-* builtins aren't in the driver's minimal injected prelude (seed handles them).
  ["num-max(2, 5)", "5"],
];
// stoppable now handles check: (promoted — see test/stoppable.test.ts check tests),
// lists, and strings; nothing pending for the stoppable compiler.
const PENDING_STOPPABLE: [string, string][] = [];

const wrap = (expr: string, expected: string) => `if (${expr}) == ${expected}: 0 else: 1 / 0 end`;

for (const [expr, expected] of MATRIX) {
  test(`tri-run agrees: ${expr.replace(/\n/g, " ")} == ${expected}`, async () => {
    // the seed computes the bare expression to EXPECTED (pins EXPECTED to the truth)
    const seedBare = await run(await buildSource(expr));
    expect(seedBare.error).toBeUndefined();
    expect(seedBare.output.trim()).toBe(expected);

    // all three compilers run the trap-wrapped program without error => they AGREE
    const w = wrap(expr, expected);
    expect(await seedOutcome(w)).toBe("ok");
    expect(await selfHostedOutcome(w)).toBe("ok");
    expect(await stoppableOutcome(w)).toBe("ok");
  });
}

// Harness teeth: a deliberately-wrong expectation must FAIL under ALL THREE compilers
// (otherwise the "ok" assertions above would be meaningless).
test("tri-run negative control: a wrong value traps under all three compilers", async () => {
  const wrongWrap = wrap("2 + 3", "6"); // 2+3 != 6 -> else branch -> 1/0 -> error
  expect(await seedOutcome(wrongWrap)).toBe("fail");
  expect(await selfHostedOutcome(wrongWrap)).toBe("fail");
  expect(await stoppableOutcome(wrongWrap)).toBe("fail");
});

// Document (don't fail) the per-compiler PENDING lists, so they stay visible and
// honest. Every pending program runs fine on the SEED today (so promotion only needs
// the named compiler to catch up). Also pin the CURRENT outcome on the lagging
// compiler so a line auto-surfaces (test failure) the moment it starts working and
// can be promoted.
test("tri-run PENDING (self-hosted) run on the SEED; not yet self-hosted", async () => {
  for (const [expr] of PENDING_SELF_HOSTED) {
    const seedExpr = expr.includes("\n") ? `block:\n${expr}\nend` : expr;
    expect(await seedOutcome(seedExpr)).toBe("ok");
  }
  // tripwire: `num-max` (a num builtin) isn't in the driver's minimal prelude yet — works
  // on seed+stoppable. When the self-hosted compiler handles it, this flips → promote it.
  expect(await selfHostedOutcome(wrap("num-max(2, 5)", "5"))).toBe("fail");
});

test("tri-run PENDING (stoppable) run on the SEED; not yet stoppable", async () => {
  for (const [expr] of PENDING_STOPPABLE) {
    const seedExpr = expr.includes("\n") ? `block:\n${expr}\nend` : expr;
    expect(await seedOutcome(seedExpr)).toBe("ok");
  }
});
