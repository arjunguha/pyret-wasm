// Mutable-variable capture by a `for`-loop body. A `for` desugars to a HOF call with
// a lambda body, so a `var` assigned inside it must be boxed and captured by-cell —
// but `for-expr` isn't a `lambda-expr` in the CST, so the free-var / boxing analysis
// previously missed it (concat-lists.arr's `each_n`: `var shadow n = n  for each(...):
// n := n + 1 end`). Also covers a `var` shadowing a param and assigned in the loop.

import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

async function result(src: string): Promise<string> {
  return (await run(await buildSource(src))).output.trim();
}

test("var assigned inside a for-loop body (captured by the loop lambda)", async () => {
  const src = `
fun sum-to(n):
  var acc = 0
  for each(i from range(1, n + 1)):
    acc := acc + i
  end
  acc
end
sum-to(5)`;
  expect(await result(src)).toBe("15");
});

test("var shadowing a param, assigned inside a for-loop body", async () => {
  const src = `
fun f(n):
  var shadow n = n
  for each(x from [list: 1, 2, 3]):
    n := n + x
  end
  n
end
f(10)`;
  expect(await result(src)).toBe("16");
});

test("var in a nested block:, assigned by a returned closure (counter)", async () => {
  const src = `
mk = block:
  var c = 0
  lam(): block: c := c + 1  c end end
end
(mk() + mk()) + mk()`;
  expect(await result(src)).toBe("6");
});
