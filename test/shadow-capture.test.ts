// A `shadow x = <expr using x>` binding must capture the OUTER x in its RHS (the
// new x is in scope only afterwards). freeVars was pre-binding the shadowed name,
// so a closure doing `shadow acc = acc.foo()` failed to capture the outer acc.
// This is pervasive in the real compiler's fold/accumulator code (e.g.
// type-check-structs' `shadow temp-variables = temp-variables.difference(...)`).

import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

async function val(src: string): Promise<string> {
  return (await run(await buildSource(src))).output.trim();
}

test("shadow let RHS captures the outer name", async () => {
  expect(await val(`fun apply1(f): f(5) end
fun h():
  b = 10
  apply1(lam(c):
    shadow b = b + c
    b
  end)
end
h()`)).toBe("15");
});

test("tuple-param lambda capturing + shadowing an outer tuple-let name", async () => {
  expect(await val(`fun mk(): {10; 20} end
fun apply2(f): f({1; 2}) end
fun h():
  {a; b} = mk()
  apply2(lam({c; d}):
    shadow b = b + c
    a + b + d
  end)
end
h()`)).toBe("33");
});

test("fold accumulator with shadow re-binding (the real pattern)", async () => {
  expect(await val(`fun fold2(f, init, xs):
  cases(List) xs: | empty => init | link(h, t) => fold2(f, f(h, init), t) end
end
fun run-it():
  total = 100
  fold2(lam(x, shadow total): total + x end, total, [list: 1, 2, 3])
end
run-it()`)).toBe("106");
});

test("non-shadow let in a closure still works (no regression)", async () => {
  expect(await val(`fun apply1(f): f(5) end
fun h():
  b = 10
  apply1(lam(c):
    x = b + c
    x
  end)
end
h()`)).toBe("15");
});
