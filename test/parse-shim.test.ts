// The parse-pyret shim provides surface-parse so the driver passes (compile-lib/repl)
// compile. Real parsing is wired later. (Tested via `include` so it's independent of
// module-qualified-member resolution.)
import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";

test("parse-pyret shim: surface-parse resolves (program compiles)", async () => {
  const wasm = await buildSource(`include parse-pyret\nfun g(s): surface-parse(s, "u") end\n0`);
  expect(wasm.length).toBeGreaterThan(8);
});
