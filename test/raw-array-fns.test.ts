// raw-array-get/-set/-length/-of are compileApp intrinsics; they're also exposed as
// first-class prelude functions (wrapping prim-* intrinsics, so no recursion) so they
// resolve as values and through the `arrays` module alias.
import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

async function out(src: string): Promise<string> {
  return (await run(await buildSource(src))).output.trim();
}

test("raw-array-get as a first-class value (bare ref)", async () => {
  expect(await out("rag = raw-array-get\nrag([raw-array: 5, 6, 7], 1)")).toBe("6");
});

test("raw-array fns passed to higher-order fns", async () => {
  expect(await out("map(raw-array-length, [list: [raw-array: 1, 2], [raw-array: 9]])")).toBe("[list: 2, 1]");
});

test("raw-array fns via the arrays module alias", async () => {
  expect(await out("import arrays as A\nA.raw-array-get([raw-array: 8, 9], 0)")).toBe("8");
});

test("direct raw-array calls still use the intrinsic (no recursion / regression)", async () => {
  expect(await out("a = [raw-array: 1, 2, 3]\nraw-array-set(a, 0, 10)\nraw-array-get(a, 0)")).toBe("10");
  expect(await out("raw-array-length(raw-array-of(0, 4))")).toBe("4");
});
