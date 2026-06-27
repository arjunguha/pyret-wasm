// Tuple binding with an `as` alias: `{a; b} as whole` binds the components AND the
// whole tuple to `whole`. The seed bound the components but dropped the `as` alias,
// so `whole` was unbound — the real compiler's pervasive accumulator pattern, e.g.
// `fun add-spec(..., {imp-e; imp-te; imp-me; imp-imps} as acc, ...)` and
// `for fold(acc from {tuple}, ...)`. Fixed in tupleAsName + bindingNames + emitBinding.

import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

async function result(src: string): Promise<string> {
  return (await run(await buildSource(src))).output.trim();
}

test("tuple-as param: binds components + the whole-tuple alias", async () => {
  expect(await result("fun f({a; b} as acc): a + acc.{1} end\nf({3; 4})")).toBe("7");
});

test("tuple-as binding inside a function body (let)", async () => {
  expect(await result("fun h(p):\n  {a; b} as acc = p\n  a + acc.{1}\nend\nh({3; 4})")).toBe("7");
});

test("tuple-as as a for-fold accumulator (uses the alias in the body)", async () => {
  expect(await result(
    "for fold({s; n} as acc from {0; 0}, x from [list: 1, 2, 3]): {s + x; acc.{1} + 1} end"
  )).toBe("{6; 3}");
});

test("nested tuple-as binding", async () => {
  expect(await result("fun g({a; {b; c}} as w): a + b + c + w.{0} end\ng({1; {2; 3}})")).toBe("7");
});
