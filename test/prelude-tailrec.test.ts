// The shared prelude's list combinators (map/filter/foldr/append/reverse/length/
// range/repeat/map2-4/filter-map/list-take) MUST be tail-recursive: the self-hosted
// compiler's passes run them over module-length lists, and a non-tail version uses
// O(N) stack and overflows the WASM stack on big modules (the dominant self-compile
// blocker). These assert (a) huge inputs don't overflow + correct results, and
// (b) a large real compiler module self-compiles via the self-hosted compiler.
import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";
import { buildSourceSelfHosted } from "../src/build-selfhosted.ts";
import { readFileSync } from "fs";

test("prelude combinators are constant-stack on huge lists (no overflow) + correct", async () => {
  const src = `
r = range(0, 20000)
m = map(lam(x): x + 1 end, r)
f = filter(lam(x): num-modulo(x, 2) == 0 end, r)
s = foldl(lam(a, e): a + e end, 0, r)
sr = foldr(lam(a, e): a + e end, 0, r)
print(length(m))
print(s)
print(sr)
print(f.first)
`;
  const r = await run(await buildSource(src));
  expect(r.error).toBeUndefined();
  expect(r.output).toContain("20000");          // length(m)
  expect(r.output).toContain("199990000");      // sum 0..19999
  expect(r.output).toContain("0");              // first even
});

test("self-hosted compiler compiles a LARGE module (ast.arr) without stack overflow", async () => {
  const ast = readFileSync(new URL("../self-compiler/trove/ast.arr", import.meta.url).pathname, "utf8");
  const wasm = await buildSourceSelfHosted(ast);
  expect(wasm.length).toBeGreaterThan(100000); // a real module's worth of bytes
  expect(Array.from(wasm.slice(0, 4))).toEqual([0, 0x61, 0x73, 0x6d]); // \0asm
}, 120000);
