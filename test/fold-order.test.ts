// List fold argument-order semantics (matching real Pyret).
//
// Real Pyret has a deliberate quirk:
//   - METHODS  lst.foldl(f, base) / lst.foldr(f, base)  call  f(elt, acc)  (element-first)
//   - FREE fns foldl(f, base, lst) / foldr(f, base, lst) call  f(acc, elt)  (acc-first)
// This pins both so the previously-swapped method order can't regress.
import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

async function out(src: string): Promise<string> {
  return (await run(await buildSource(src))).output.trim();
}

// Using string concatenation (non-commutative) makes the order observable.
test("List .foldr method is element-first: f(elt, acc)", async () => {
  // f("a", f("b", f("c", "Z"))) = "a" + ("b" + ("c" + "Z")) = "abcZ"
  expect(await out(`[list: "a", "b", "c"].foldr(lam(v, acc): v + acc end, "Z")`)).toBe("abcZ");
});

test("List .foldl method is element-first: f(elt, acc), folding from the left", async () => {
  // acc0="Z"; f("a","Z")="aZ"; f("b","aZ")="baZ"; f("c","baZ")="cbaZ"
  expect(await out(`[list: "a", "b", "c"].foldl(lam(v, acc): v + acc end, "Z")`)).toBe("cbaZ");
});

test("free foldl/foldr stay acc-first: f(acc, elt)", async () => {
  // free foldl(f, base, lst): f(acc, elt) -> "Z"+"a"="Za", +"b", +"c" = "Zabc"
  expect(await out(`import lists as L\nL.foldl(lam(acc, v): acc + v end, "Z", [list: "a", "b", "c"])`)).toBe("Zabc");
  // free foldr(f, base, lst): f(acc, elt) folding right -> "Z"+"c"+"b"+"a" = "Zcba"
  expect(await out(`import lists as L\nL.foldr(lam(acc, v): acc + v end, "Z", [list: "a", "b", "c"])`)).toBe("Zcba");
});

test("commutative method folds (sum) are unaffected", async () => {
  expect(await out(`[list: 1, 2, 3, 4].foldl(lam(e, a): e + a end, 0)`)).toBe("10");
  expect(await out(`[list: 1, 2, 3, 4].foldr(lam(e, a): e + a end, 0)`)).toBe("10");
});
