// Raw-array builders + list/string helpers added to the prelude (used by the real
// Pyret compiler front-end). Each program ends in a boolean comparison so the
// printed result is an unambiguous "true" when the builtin is correct.
import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

async function ok(src: string): Promise<string> {
  return (await run(await buildSource(src))).output.trim();
}

test("raw-array-build builds f(0)..f(n-1)", async () => {
  expect(await ok(`raw-array-to-list(raw-array-build(lam(i): i + 1 end, 3)) == [list: 1, 2, 3]`)).toBe("true");
});

test("raw-array-duplicate copies the array", async () => {
  expect(await ok(`raw-array-to-list(raw-array-duplicate(raw-array-from-list([list: 5, 6, 7]))) == [list: 5, 6, 7]`)).toBe("true");
});

test("filter-map keeps the some-values", async () => {
  expect(await ok(`filter-map(lam(x): if x > 2: some(x * 10) else: none end end, [list: 1, 2, 3, 4]) == [list: 30, 40]`)).toBe("true");
});

test("partition splits into is-true / is-false", async () => {
  expect(await ok(`partition(lam(x): x > 2 end, [list: 1, 2, 3, 4]).is-true == [list: 3, 4]`)).toBe("true");
  expect(await ok(`partition(lam(x): x > 2 end, [list: 1, 2, 3, 4]).is-false == [list: 1, 2]`)).toBe("true");
});

test("distinct removes duplicates", async () => {
  expect(await ok(`distinct([list: 1, 2, 2, 3, 3, 3]) == [list: 1, 2, 3]`)).toBe("true");
});

test("take / drop", async () => {
  expect(await ok(`take([list: 1, 2, 3, 4], 2) == [list: 1, 2]`)).toBe("true");
  expect(await ok(`drop([list: 1, 2, 3, 4], 2) == [list: 3, 4]`)).toBe("true");
});

test("list-to-set / list-to-tree-set dedupe", async () => {
  expect(await ok(`list-to-set([list: 1, 2, 2, 3]).size() == 3`)).toBe("true");
  expect(await ok(`list-to-tree-set([list: 1, 1, 1]).size() == 1`)).toBe("true");
});

test("string-join", async () => {
  expect(await ok(`string-join([list: "a", "b", "c"], "-") == "a-b-c"`)).toBe("true");
  expect(await ok(`string-join([list: ], "-") == ""`)).toBe("true");
});

test("string-split (first occurrence) and string-split-all", async () => {
  expect(await ok(`string-split("a-b-c", "-") == [list: "a", "b-c"]`)).toBe("true");
  expect(await ok(`string-split-all("a-b-c", "-") == [list: "a", "b", "c"]`)).toBe("true");
  expect(await ok(`string-split-all("abc", "-") == [list: "abc"]`)).toBe("true");
});

test("string-replace replaces all occurrences", async () => {
  expect(await ok(`string-replace("a-b-c", "-", "+") == "a+b+c"`)).toBe("true");
});
