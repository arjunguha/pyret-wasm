// Additional pure prelude builtins the corpus references. Convention (matches
// corpus-fixes/roughnum/e2e tests): the trailing EXPRESSION's value is rendered
// once — don't use `print` (it double-renders under buildSource+run).
import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

async function out(src: string): Promise<string> {
  const { output, error } = await run(await buildSource(src));
  expect(error).toBeUndefined();
  return output.trimEnd();
}

test("num-equal: boolean numeric equality", async () => {
  expect(await out(`num-equal(2, 2)`)).toBe("true");
  expect(await out(`num-equal(2, 3)`)).toBe("false");
  expect(await out(`num-equal(1/2, 0.5)`)).toBe("true"); // exact rational == decimal-rational
});

test("num-equal usable as a first-class value (HOF arg)", async () => {
  expect(await out(`map(lam(p): num-equal(p, 2) end, [list: 1, 2, 3])`))
    .toBe("[list: false, true, false]");
});
