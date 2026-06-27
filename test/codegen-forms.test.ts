// Core codegen-form regressions (CORE CODEGEN FORMS stream).
// Kept separate from e2e.test.ts to avoid merge conflicts during the parallel grind.

import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

async function result(src: string): Promise<string> {
  return (await run(await buildSource(src))).output.trim();
}

// A `cases` branch may name a variant that is NOT a constructor of the scrutinee's
// type — a dead branch real Pyret tolerates (e.g. ast-anf.arr's `cases(ALettable)
// ... | a-array` where ALettable has no a-array). It must compile and never match;
// the real branches must still work.
test("cases tolerates a dead branch for an unknown variant", async () => {
  const src = `
data Foo: | bar(x) | baz(y) end
fun f(v):
  cases(Foo) v:
    | bar(x) => x + 1
    | baz(y) => y + 2
    | not-a-real-variant(z) => z + 100
  end
end
f(bar(10)) + f(baz(20))`;
  expect(await result(src)).toBe("33"); // 11 + 22
});
