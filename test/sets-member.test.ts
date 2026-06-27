// The front-end refers to the sets module by NAME (e.g. `sets.list-to-list-set`)
// even when imported `as S`; a prelude global `sets` object exposes the set API so
// those qualified references resolve. (compile-lib.arr:336 uses sets.list-to-list-set.)
import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

const out = async (src: string) => (await run(await buildSource(src))).output.trim();

test("list-to-list-set: bare, via alias, and via module name", async () => {
  expect(await out("list-to-list-set([list: 1, 2, 2]).to-list()")).toBe("[list: 2, 1]");
  expect(await out("import sets as S\nS.list-to-list-set([list: 1, 2, 2]).to-list()")).toBe("[list: 2, 1]");
  // module-name-qualified (the compile-lib usage form)
  expect(await out("import sets as S\nsets.list-to-list-set([list: 1, 2, 2]).to-list()")).toBe("[list: 2, 1]");
});

test("sets.<member> module-name access for the set API", async () => {
  expect(await out("sets.list-to-set([list: 3, 3, 4]).size()")).toBe("2");
  expect(await out("sets.list-to-tree-set([list: 9, 9]).size()")).toBe("1");
  expect(await out("sets.empty-set.add(7).member(7)")).toBe("true");
});
