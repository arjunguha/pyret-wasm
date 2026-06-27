// Core codegen-form regressions (CORE CODEGEN FORMS stream).
// Kept separate from e2e.test.ts to avoid merge conflicts during the parallel grind.

import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

async function result(src: string): Promise<string> {
  return (await run(await buildSource(src))).output.trim();
}

// A `cases` branch may name a variant that is NOT a constructor of the scrutinee's
// type — a dead branch real Pyret tolerates (e.g. ast-anf.arr's `cases(ALettable)
// ... | a-array` where ALettable has no a-array). It must compile and never match;
// the real branches must still work.
test("cases tolerates a dead branch for an unknown variant", async () => {
  const src = `
data Foo: | bar(x) | baz(y) end
fun f(v):
  cases(Foo) v:
    | bar(x) => x + 1
    | baz(y) => y + 2
    | not-a-real-variant(z) => z + 100
  end
end
f(bar(10)) + f(baz(20))`;
  expect(await result(src)).toBe("33"); // 11 + 22
});

// multi-let-expr: `let a = e1, b = e2 (block|:) body end` (binds wrapped in let-binding).
test("multi-let-expr: single, multiple, and sequential bindings", async () => {
  expect(await result("let x = 5: x + 1 end")).toBe("6");
  expect(await result("let a = 1, b = 2: a + b end")).toBe("3");
  expect(await result("let a = 10, b = a + 5: b end")).toBe("15"); // later bind sees earlier
});

// type-let erases its type bindings; var inside a let works.
test("type-let-expr (erased) and var binding in a let", async () => {
  expect(await result("type-let N = Number: 40 + 2 end")).toBe("42");
  expect(await result("let var c = 0: block: c := c + 7\n c end end")).toBe("7");
});

// tuple-binding destructuring: in a let and in a cases pattern (incl. `_` + nested).
test("tuple-binding destructuring (let + cases)", async () => {
  expect(await result("block:\n  {a; b} = {10; 32}\n  a + b\nend")).toBe("42");
  expect(await result("block:\n  {a; b; c} = {1; 2; 3}\n  (a + b) + c\nend")).toBe("6");
  expect(await result("block:\n  {x; _} = {7; 99}\n  x\nend")).toBe("7");
  const cs = `
data Box: | bx(t) end
fun f(v): cases(Box) v: | bx({a; b}) => a + b end end
f(bx({3; 4}))`;
  expect(await result(cs)).toBe("7");
});

// letrec: names in scope for all bind values -> (mutual) recursion via boxed cells.
test("letrec-expr supports self- and mutual recursion", async () => {
  expect(await result("letrec a = 3, b = 4: a * b end")).toBe("12");
  expect(await result(
    "letrec f = lam(n): if n < 1: 0 else: n + f(n - 1) end end: f(5) end")).toBe("15");
  expect(await result(
    "letrec even = lam(n): if n == 0: true else: odd(n - 1) end end,\n" +
    "       odd = lam(n): if n == 0: false else: even(n - 1) end end:\n" +
    "  even(10) end")).toBe("true");
});
