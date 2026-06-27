// sha JS-trove shim: the compiler uses sha256 as a stable cache/module key. The
// Pyret shim (self-compiler/trove/sha.arr) is a deterministic non-crypto hash —
// stable for equal inputs, distinct for different inputs, non-empty.

import { test, expect } from "bun:test";
import { buildSourceFile } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";
import { tmpdir } from "os";
import { resolve } from "path";

test("sha trove shim: sha256 is stable, distinct, non-empty", async () => {
  const p = resolve(tmpdir(), "sha-shim-test.arr");
  await Bun.write(
    p,
    `import sha as S
stable = S.sha256("hello") == S.sha256("hello")
distinct = not(S.sha256("alpha") == S.sha256("beta"))
nonempty = string-length(S.sha256("hello")) > 0
(stable and distinct) and nonempty`,
  );
  const r = await run(await buildSourceFile(p));
  expect(r.output.trim()).toBe("true"); // stable AND distinct AND non-empty
});
