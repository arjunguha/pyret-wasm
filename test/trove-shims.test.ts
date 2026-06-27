// JS-trove module reconciliation: trove modules implemented in JS upstream (not
// .arr) are provided as Pyret shims under self-compiler/trove/ so the real compiler
// front-end links. source-map-lib is stubbed (source maps are not needed for WASM).

import { test, expect } from "bun:test";
import { buildSourceFile } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";
import { tmpdir } from "os";
import { resolve } from "path";

test("source-map-lib JS-trove shim resolves + stubs (satisfies js-ast call sites)", async () => {
  const p = resolve(tmpdir(), "sm-shim-test.arr");
  await Bun.write(
    p,
    `import source-map-lib as SM
m = SM.new-map(1, 2, "uri", "name")
n1 = m.start-node(1, 2, "u", "x")
n2 = m.end-node()
n3 = m.string("s")
g = m.get()
string-length(SM.to-string-with-source-map(g, "uri"))`,
  );
  const r = await run(await buildSourceFile(p));
  expect(r.output.trim()).toBe("0"); // stubbed source map -> empty string -> length 0
});
