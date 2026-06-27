// The filelib trove stub shim (so the driver / JS-backend modules — compile-lib, repl,
// js-of-pyret, via file.arr — compile in the WASM build). buildSourceFile so the trove
// import actually loads.
import { test, expect } from "bun:test";
import { buildSourceFile } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

test("filelib shim members resolve, load, and run", async () => {
  const lines = (await run(await buildSourceFile("test/fixtures/io-shim.arr"))).output.trim().split("\n");
  expect(lines[0]).toBe("/a/b");  // real-path identity
  expect(lines[1]).toBe("false"); // exists stub
  expect(lines[2]).toBe("false"); // is-dir stub
});
