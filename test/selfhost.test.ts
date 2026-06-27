// The SELF-HOSTED compiler path: programs compiled by the compiler written in
// Pyret (selfhost/compiler.arr + modules), itself compiled to WASM by the seed.
//
// TESTING DISCIPLINE (per the goal): every program here is run through BOTH the
// seed compiler AND the self-hosted ("compiler-compiled") compiler, and the two
// must agree. As the self-hosted compiler grows toward the full language, this
// dual-run set expands to cover the whole e2e suite. The ultimate gate is the
// self-hosting FIXPOINT (compiler.wasm compiling its own source byte-identically) —
// measured by scripts/selfhost-fixpoint.ts; not yet reached (the self-hosted
// compiler is a bounded subset today: fun/if/let/calls/recursion, integer arith).

import { test, expect } from "bun:test";
import { buildSelfHosted, runSelfHosted, compileSelfHostCompiler } from "../src/build-selfhost.ts";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

// The seed path's printed result for the same program (ground truth).
async function seedResult(src: string): Promise<string> {
  return (await run(await buildSource(src))).output.trim();
}

const FACT = "fun fact(n): if n < 2: 1 else: n * fact(n - 1) end end\nfact(5)";
const TRI = "fun tri(n): if n < 1: 0 else: n + tri(n - 1) end end\ntri(100)";

// Programs valid AND unambiguous in BOTH the seed (real Pyret) and the self-hosted
// subset. NB: Pyret has NO operator precedence (mixed operators must be parenthesized),
// so arithmetic here is fully parenthesized to agree under both compilers.
const DUAL = [
  "(2 + 3) * 4",
  "10 - (3 - 1)",
  "((1 + 2) + 3) + 4",
  "fun dbl(x): x + x end\ndbl(21)",
  "fun pick(n): if n < 5: 1 else: 0 end end\npick(3)",
  FACT,
  TRI,
];

// EVERY program above, through both compilers, must agree.
for (const src of DUAL) {
  test(`seed == self-hosted: ${JSON.stringify(src).slice(0, 40)}`, async () => {
    const seed = await seedResult(src);
    const sh = String(await runSelfHosted(src));
    expect(sh).toBe(seed);
  });
}

// Compiling the compiler ITSELF (Stage A) and then exercising the compiled compiler.
test("compiles the compiler itself (seed -> compiler.wasm), then exercises it", async () => {
  const compilerWasm = await compileSelfHostCompiler();
  expect(Array.from(compilerWasm.slice(0, 4))).toEqual([0, 0x61, 0x73, 0x6d]); // \0asm
  // the compiled-to-WASM compiler then compiles+runs several programs:
  expect(await runSelfHosted(FACT)).toBe(120);
  expect(await runSelfHosted(TRI)).toBe(5050);
  expect(await runSelfHosted("(2 + 3) * 4")).toBe(20);
});

// read-source actually delivers the (varying) runtime source into the in-WASM
// compiler — not a hardcoded string.
test("self-hosted: read-source delivers runtime source (not hardcoded)", async () => {
  const mk = (n: number) => `fun fact(n): if n < 2: 1 else: n * fact(n - 1) end end\nfact(${n})`;
  expect(await runSelfHosted(mk(5))).toBe(120);
  expect(await runSelfHosted(mk(6))).toBe(720);
  expect(await runSelfHosted(mk(0))).toBe(1);
});

test("self-hosted: emits a non-empty self-contained module", async () => {
  const wasm = await buildSelfHosted("1 + 2");
  expect(wasm.length).toBeGreaterThan(8);
  expect(Array.from(wasm.slice(0, 4))).toEqual([0, 0x61, 0x73, 0x6d]); // \0asm
});
