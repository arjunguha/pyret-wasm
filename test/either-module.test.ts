// The `either` trove module (Either: left | right) must load + link so that
// `import either as E` resolves E.left / E.right / E.is-right (it was wrongly in
// build.ts SKIP_MODULES, treated as prelude-provided though the prelude has no Either).

import { test, expect } from "bun:test";
import { buildSourceFile } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

test("either module: E.left / E.right / E.is-right resolve", async () => {
  const dir = mkdtempSync(join(tmpdir(), "either-"));
  const f = join(dir, "m.arr");
  await Bun.write(
    f,
    [
      "import either as E",
      "fun classify(e): cases(E.Either) e: | left(v) => 0 - v | right(v) => v end end",
      // exercises right, left, is-right, is-left, and cases over E.Either:
      "ok = E.is-right(E.right(5)) and E.is-left(E.left(7))",
      "if ok: classify(E.right(5)) else: 0 - 1 end", // -> 5 only if everything resolved
    ].join("\n") + "\n",
  );
  const out = (await run(await buildSourceFile(f))).output.trim();
  expect(out).toBe("5");
});
