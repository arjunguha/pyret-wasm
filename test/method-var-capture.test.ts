// A `var` captured AND assigned by an object/extension METHOD must be boxed (shared
// cell), just like one captured by a lambda. Methods go through buildClosureFromParts,
// but freeInNestedClosures/freeVars previously only recognized lambda/fun as closures,
// so the captured var wasn't boxed and `:=` inside the method failed. Plus `_` curry.
import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

async function out(src: string): Promise<string> {
  return (await run(await buildSource(src))).output.trim();
}

test("var captured + assigned by an object-literal method", async () => {
  const src = `fun f():
  var c = 0
  v = { method m(self): c := c + 1\n c end }
  v.m() + v.m()
end
f()`;
  expect(await out(src)).toBe("3"); // 1 + 2
});

test("var captured + assigned by an extension method (.{...})", async () => {
  const src = `fun f():
  var c = 0
  v = {a: 1}.{ method m(self): c := c + 1\n c end }
  v.m() + v.m()
end
f()`;
  expect(await out(src)).toBe("3");
});

test("method uses self AND captures+mutates an outer var (count-apps shape)", async () => {
  const src = `data E: | ap(f, a) | lit(n) end
fun cnt(e):
  var c = 0
  v = {} .{ method go(self, x):
      cases(E) x: | ap(g, a) => block: c := c + 1\n self.go(g) end | lit(n) => c end
    end }
  v.go(e)
  c
end
cnt(ap(ap(lit(1), lit(2)), lit(3)))`;
  expect(await out(src)).toBe("2"); // two `ap` nodes on the left spine
});

test("_ currying: dot, sole-arg, and positional", async () => {
  expect(await out(`map(_.first, [list: [list: 7], [list: 9]])`)).toBe("[list: 7, 9]");
  expect(await out(`fun dbl(x): x * 2 end\nmap(dbl(_), [list: 1, 2, 3])`)).toBe("[list: 2, 4, 6]");
  expect(await out(`fun add(a, b): a + b end\nmap(add(_, 10), [list: 1, 2, 3])`)).toBe("[list: 11, 12, 13]");
});
