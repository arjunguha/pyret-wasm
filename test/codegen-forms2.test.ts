// Codegen-forms stream (round 2): tuple-binding parameters + a `var` declared in a
// block: expression and captured+assigned by a nested closure. Both were blockers in
// Pyret's real front-end (type-structs.arr's `lam({field-name; typ}): ...`, js-ast.arr's
// `next-j-fun-id = block: var n = 0  lam(): n := n + 1 ... end`).

import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

async function result(src: string): Promise<string> {
  return (await run(await buildSource(src))).output.trim();
}

test("tuple-binding parameter in a fun", async () => {
  expect(await result("fun add({a; b}): a + b end\nadd({10; 20})")).toBe("30");
});

test("tuple-binding parameter in a lambda", async () => {
  expect(await result("f = lam({a; b}): a + b end\nf({2; 3})")).toBe("5");
});

test("tuple-binding param in a lambda passed to map", async () => {
  expect(await result("map(lam({a; b}): a + b end, [list: {1; 2}, {3; 4}])")).toBe("[list: 3, 7]");
});

test("nested tuple-binding parameter", async () => {
  expect(await result("fun f({a; {b; c}}): (a + b) + c end\nf({1; {2; 3}})")).toBe("6");
});

test("var in a block captured + assigned by a closure (shared cell)", async () => {
  const src = [
    "counter = block:",
    "  var n = 0",
    "  lam() block: n := n + 1",
    "    n end",
    "end",
    "counter()",       // 1
    "counter() + counter()", // 2 + 3
  ].join("\n");
  expect(await result(src)).toBe("5");
});
