// DUAL-RUN MATRIX — every supported program must compile+run through BOTH the
// seed compiler AND the self-hosted compiler (self-host/compile-driver.arr) and
// AGREE on the computed value. This is the growing regression net proving the two
// compilers are equivalent as self-hosted coverage rises (the path to the fixpoint).
//
// HOW agreement is checked WITHOUT relying on stdout: the self-hosted compiler runs
// a program's top-level expression but does NOT yet print its result (the seed does).
// So we can't compare stdout. Instead we use the TRAP-ON-WRONG-VALUE technique (same
// idea as test/selfhost-e2e.test.ts): wrap each program as
//     if (EXPR) == EXPECTED: 0 else: 1 / 0 end
// which runs WITHOUT error iff the compiler computed EXPR == EXPECTED. Running the
// wrapped program through BOTH compilers and asserting neither errors proves they
// agree on the value. A negative-control test confirms a wrong EXPECTED makes BOTH
// fail (so the harness actually has teeth). We also assert the seed's own output for
// the bare EXPR equals EXPECTED, which pins EXPECTED to the true value.
//
// To PROMOTE a program from `PENDING` to the matrix: move its line up once the
// self-hosted compiler handles it. One line per program.

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
];

// Programs the self-hosted compiler can't handle YET — promote to MATRIX above as
// the driver grows (data/cases reach anf, prelude inclusion gives lists/print, etc.).
const PENDING: [string, string][] = [
  ["check: 2 + 3 is 5 end", "(check block)"],
  ["[list: 1, 2, 3].length()", "3"],
  ["data D: | a(n) | b end\ncases(D) a(7): | a(n) => n | b => 0 end", "7"],
  ['"ab" + "cd"', '"abcd"'],
];

const wrap = (expr: string, expected: string) => `if (${expr}) == ${expected}: 0 else: 1 / 0 end`;

for (const [expr, expected] of MATRIX) {
  test(`dual-run agrees: ${expr.replace(/\n/g, " ")} == ${expected}`, async () => {
    // the seed computes the bare expression to EXPECTED (pins EXPECTED to the truth)
    const seedBare = await run(await buildSource(expr));
    expect(seedBare.error).toBeUndefined();
    expect(seedBare.output.trim()).toBe(expected);

    // both compilers run the trap-wrapped program without error => they AGREE on the value
    const w = wrap(expr, expected);
    expect(await seedOutcome(w)).toBe("ok");
    expect(await selfHostedOutcome(w)).toBe("ok");
  });
}

// Harness teeth: a deliberately-wrong expectation must FAIL under BOTH compilers
// (otherwise an "ok/ok" above would be meaningless).
test("dual-run negative control: a wrong value traps under both compilers", async () => {
  const wrongWrap = wrap("2 + 3", "6"); // 2+3 != 6 -> else branch -> 1/0 -> error
  expect(await seedOutcome(wrongWrap)).toBe("fail");
  expect(await selfHostedOutcome(wrongWrap)).toBe("fail");
});

// Document (don't assert) what the self-hosted compiler can't do yet, so the
// PENDING list stays visible and honest. These run fine on the seed today.
test("dual-run PENDING programs still compile+run on the SEED (promote when self-hosted)", async () => {
  for (const [expr] of PENDING) {
    // each pending program at least works on the seed (so promotion only needs the
    // self-hosted side to catch up — the value/shape is already validated elsewhere).
    const seedExpr = expr.includes("\n") ? `block:\n${expr}\nend` : expr;
    expect(await seedOutcome(seedExpr)).toBe("ok");
  }
});
