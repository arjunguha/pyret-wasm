// Seed corpus run-pass fixes: (1) unary intrinsics usable as first-class VALUES
// (previously "unbound identifier" when passed to a HOF), (2) pure prelude builtins
// the corpus references (sign predicates, within-*-now, PI).
// Convention (matches roughnum/e2e tests): the trailing EXPRESSION's value is
// rendered once — don't use `print` (it double-renders under buildSource+run).
import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

async function out(src: string): Promise<string> {
  const { output, error } = await run(await buildSource(src));
  expect(error).toBeUndefined();
  return output.trimEnd();
}

test("type-predicate intrinsics work as first-class values", async () => {
  expect(await out(`map(lam(f): f(5) end, [list: is-number, is-string, is-function])`))
    .toBe("[list: true, false, false]");
  expect(await out(`[list: 1, "a", 2, "b"].filter(is-number)`)).toBe("[list: 1, 2]");
});

test("num predicates / functions as values", async () => {
  expect(await out(`map(num-sqrt, [list: 4, 9, 16])`)).toBe("[list: ~2, ~3, ~4]");
  expect(await out(`[list: 1, 2, 4].map(num-is-integer)`)).toBe("[list: true, true, true]");
});

test("sign predicates", async () => {
  expect(await out(`num-is-positive(3)`)).toBe("true");
  expect(await out(`num-is-negative(0 - 2)`)).toBe("true");
  expect(await out(`num-is-non-negative(0)`)).toBe("true");
});

test("within-*-now family + PI", async () => {
  expect(await out(`within-abs-now(0.5)(1, 1.2)`)).toBe("true");
  expect(await out(`within-now(0.1)(10, 10.05)`)).toBe("true");
  expect(await out(`num-floor(PI)`)).toBe("~3"); // PI is a roughnum -> floor stays rough
});

test("direct intrinsic calls still work (call-site path unchanged)", async () => {
  expect(await out(`is-number(5)`)).toBe("true");
  expect(await out(`num-sqrt(9)`)).toBe("~3");
});
