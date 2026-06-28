// DUAL-RUN MATRIX — every supported program must compile+run through BOTH
// compilers and AGREE on the computed value:
//   (1) the SEED compiler (src/build.ts),
//   (2) the SELF-HOSTED compiler (self-host/compile-driver.arr, via build-selfhosted.ts).
// This is the regression net proving the two compilers are equivalent as coverage rises.
// (The in-Pyret stoppable/CPS compiler is exercised separately by selfhost-stoppable.test.ts;
// the old seed-side stoppable compiler has been removed.)
//
// HOW agreement is checked WITHOUT relying on stdout: the self-hosted compiler runs
// a program's top-level expression but does NOT yet print its result the same way the
// seed does. So we can't compare stdout. Instead we use the TRAP-ON-WRONG-VALUE technique
// (same idea as test/selfhost-e2e.test.ts): wrap each program as
//     if (EXPR) == EXPECTED: 0 else: 1 / 0 end
// which runs WITHOUT error iff the compiler computed EXPR == EXPECTED. Running the
// wrapped program through BOTH compilers and asserting neither errors proves they
// agree on the value. A negative-control test confirms a wrong EXPECTED makes BOTH
// fail (so the harness actually has teeth). We also assert the seed's own
// output for the bare EXPR equals EXPECTED, which pins EXPECTED to the true value.
//
// To PROMOTE a program into the matrix: both compilers must handle it. The PENDING list
// below tracks what the self-hosted compiler can't do yet (one line per program).

import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { buildSourceSelfHosted } from "../src/build-selfhosted.ts";
import { run } from "../src/runtime/run.ts";

// "ok" iff the program compiles AND runs with no error under the given compiler.
async function seedOutcome(src: string): Promise<"ok" | "fail"> {
  try { return (await run(await buildSource(src))).error ? "fail" : "ok"; }
  catch { return "fail"; }
}
async function selfHostedOutcome(src: string): Promise<"ok" | "fail"> {
  try { return (await run(await buildSourceSelfHosted(src))).error ? "fail" : "ok"; }
  catch { return "fail"; }
}

// [expression, expected-value-as-Pyret-source]. All currently yield numbers.
// Every entry compiles+runs+agrees under BOTH compilers (verified below).
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

// PENDING — programs the self-hosted compiler can't handle YET. Promote into MATRIX once
// it catches up. (The seed handles all of these today.)
const PENDING_SELF_HOSTED: [string, string][] = [
  // num-* builtins aren't in the driver's minimal injected prelude (seed handles them).
  ["num-max(2, 5)", "5"],
];

const wrap = (expr: string, expected: string) => `if (${expr}) == ${expected}: 0 else: 1 / 0 end`;

for (const [expr, expected] of MATRIX) {
  test(`dual-run agrees: ${expr.replace(/\n/g, " ")} == ${expected}`, async () => {
    // the seed computes the bare expression to EXPECTED (pins EXPECTED to the truth)
    const seedBare = await run(await buildSource(expr));
    expect(seedBare.error).toBeUndefined();
    expect(seedBare.output.trim()).toBe(expected);

    // both compilers run the trap-wrapped program without error => they AGREE
    const w = wrap(expr, expected);
    expect(await seedOutcome(w)).toBe("ok");
    expect(await selfHostedOutcome(w)).toBe("ok");
  });
}

// Harness teeth: a deliberately-wrong expectation must FAIL under both compilers
// (otherwise the "ok" assertions above would be meaningless).
test("dual-run negative control: a wrong value traps under both compilers", async () => {
  const wrongWrap = wrap("2 + 3", "6"); // 2+3 != 6 -> else branch -> 1/0 -> error
  expect(await seedOutcome(wrongWrap)).toBe("fail");
  expect(await selfHostedOutcome(wrongWrap)).toBe("fail");
});

// Document (don't fail) the PENDING list, so it stays visible and honest. Every pending
// program runs fine on the SEED today (so promotion only needs the self-hosted compiler to
// catch up). Also pin the CURRENT outcome on the self-hosted compiler so a line
// auto-surfaces (test failure) the moment it starts working and can be promoted.
test("dual-run PENDING (self-hosted) run on the SEED; not yet self-hosted", async () => {
  for (const [expr] of PENDING_SELF_HOSTED) {
    const seedExpr = expr.includes("\n") ? `block:\n${expr}\nend` : expr;
    expect(await seedOutcome(seedExpr)).toBe("ok");
  }
  // tripwire: `num-max` (a num builtin) isn't in the driver's minimal prelude yet — works
  // on the seed. When the self-hosted compiler handles it, this flips → promote it.
  expect(await selfHostedOutcome(wrap("num-max(2, 5)", "5"))).toBe("fail");
});
