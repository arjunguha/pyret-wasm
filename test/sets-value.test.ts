// Set values + constructors (value-model): bare empty-set identifiers and
// [list-set:]/[tree-set:] constructs that the real front-end uses.
import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

const out = async (src: string) => (await run(await buildSource(src))).output.trim();

test("empty-list-set / empty-tree-set / empty-set values dedup + add", async () => {
  expect(await out("empty-list-set.add(1).add(2).add(1).size()")).toBe("2");
  expect(await out("empty-tree-set.add(5).member(5)")).toBe("true");
  expect(await out("empty-set.add(7).member(7)")).toBe("true");
});

test("[list-set:] / [tree-set:] constructors dedup", async () => {
  expect(await out("[list-set: 3, 1, 3, 2].size()")).toBe("3");
  expect(await out("[tree-set: 9].member(9)")).toBe("true");
});

test("set union / intersect / difference", async () => {
  expect(await out("[tree-set: 1, 2].union([tree-set: 2, 3]).size()")).toBe("3");
  expect(await out("[list-set: 1, 2, 3].intersect([list-set: 2, 3, 4]).size()")).toBe("2");
  expect(await out("[list-set: 1, 2, 3].difference([list-set: 2]).size()")).toBe("2");
});
