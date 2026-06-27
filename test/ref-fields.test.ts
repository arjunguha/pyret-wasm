// Mutable `ref` data fields + get-bang (`obj!field`) read and set-bang
// (`obj!{field: v}`) write. Ref fields are stored as shared 1-cell boxes, so a
// mutation through one reference is visible through every reference.

import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

async function result(src: string): Promise<string> {
  return (await run(await buildSource(src))).output.trim();
}

test("ref field: get-bang read, set-bang write, non-ref field via dot", async () => {
  expect(await result(
    "data Box: | bx(ref v, w) end\n" +
    "b = bx(10, 20)\n" +
    "x = b!v\n" +     // 10
    "b!{v: 99}\n" +
    "y = b!v\n" +     // 99
    "x + y + b.w",    // 10 + 99 + 20
  )).toBe("129");
});

test("ref field: mutation is shared across references", async () => {
  expect(await result(
    "data Cell: | cell(ref val) end\n" +
    "c = cell(1)\n" +
    "fun bump(k): k!{val: k!val + 1} end\n" +
    "bump(c)\n" +
    "bump(c)\n" +
    "c!val",   // 3
  )).toBe("3");
});

test("update-expr returns the (mutated) object", async () => {
  expect(await result(
    "data Counter: | ctr(ref n) end\n" +
    "c = ctr(5)\n" +
    "(c!{n: 7})!n",  // update returns c, then read n -> 7
  )).toBe("7");
});
