// The parse-pyret shim provides surface-parse so the driver passes (compile-lib/repl)
// compile. Uses buildSourceFile (not buildSource) because `include parse-pyret` needs
// trove module-loading, which only the file-based entry performs. Real parsing later.
import { test, expect } from "bun:test";
import { buildSourceFile } from "../src/build.ts";

test("parse-pyret shim: surface-parse resolves (program compiles)", async () => {
  const wasm = await buildSourceFile("test/fixtures/parse-shim.arr");
  expect(wasm.length).toBeGreaterThan(8);
});
