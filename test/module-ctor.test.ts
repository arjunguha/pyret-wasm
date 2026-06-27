// Module-qualified data constructors / predicates resolve to the imported module's
// variants/predicates (`L.Ne(...)`, `cases(L.R)`, `L.is-Ne(...)`). The seed's
// resolveName already reifies constructors/predicates; this confirms it works through
// a module alias for a loaded module.
import { test, expect } from "bun:test";
import { buildSourceFile } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";
import { tmpdir } from "os";
import { writeFileSync, mkdtempSync } from "fs";
import { join } from "path";

test("module-qualified ctor/predicate from a loaded module", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mctest-"));
  writeFileSync(join(dir, "lib.arr"), "provide *\ndata R: | Eq | Ne(why) end\nfun helper(x): x + 1 end\n");
  writeFileSync(join(dir, "main.arr"),
    'import file("./lib.arr") as L\n' +
    'n = L.Ne("x")\n' +
    '(cases(L.R) n: | Eq => 0 | Ne(w) => 1 end) + L.helper(40) + (if L.is-Ne(n): 100 else: 0 end)\n');
  const r = await run(await buildSourceFile(join(dir, "main.arr")));
  expect(r.output.trim()).toBe("142");
});
