// Forward / mutual references among sibling LOCAL funs in a block. The real
// front-end relies on this (e.g. ast-util.arr's `collect-shared-fields` calls
// `members-to-t-members`, defined later in the same enclosing fun). compileBlock
// hoists local-fun names (boxed cells) so refs resolve regardless of order.

import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

async function result(src: string): Promise<string> {
  return (await run(await buildSource(src))).output.trim();
}

test("local fun used before its (later) sibling definition", async () => {
  const src = `
fun outer():
  init = use-later(10)        # use-later is defined further down
  init + 1
end
fun use-later(n): helper(n) * 2 end
fun helper(n): n + 5 end
outer()`;
  expect(await result(src)).toBe("31"); // (helper(10)=15)*2=30, +1 = 31
});

test("mutually-recursive local funs (forward ref)", async () => {
  const src = `
fun run-it():
  fun ev(n): if n <= 0: true else: od(n - 1) end end
  fun od(n): if n <= 0: false else: ev(n - 1) end end
  ev(10)
end
run-it()`;
  expect(await result(src)).toBe("true");
});
