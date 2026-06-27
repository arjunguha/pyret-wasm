// The CLI can route a program through the SELF-HOSTED compiler (--self-hosted),
// falling back to the seed for programs outside its current subset.
//
// Two layers are tested:
//   1. the functions the CLI uses (buildSelfHosted / runSelfHostedModule) directly
//      — fast + deterministic; and
//   2. the `pyretc run --self-hosted <file>` command end to end via a subprocess,
//      including the seed fallback.
//
// Self-hosted subset TODAY (self-host/compile-driver.arr): literals, operators,
// applications, lambdas, `if`/functions/`check` route through it; constructs the
// driver's desugar doesn't handle yet (e.g. `[list: ...]`, `data`) fall back to the
// seed. As the driver grows, more programs route through.

import { test, expect } from "bun:test";
import { resolve } from "path";
import { buildSourceSelfHosted as buildSelfHosted, runSelfHostedModule } from "../src/build-selfhosted.ts";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

const CLI = resolve(import.meta.dir, "../src/cli.ts");
const LIT = resolve(import.meta.dir, "fixtures/cli-selfhost-lit.arr");          // "5"
const FALLBACK = resolve(import.meta.dir, "fixtures/cli-selfhost-fallback.arr"); // "print([list: 5])"

test("self-hosted compiler compiles + runs a program in its subset (a literal)", async () => {
  const wasm = await buildSelfHosted("5");
  expect(Array.from(wasm.slice(0, 4))).toEqual([0, 0x61, 0x73, 0x6d]); // \0asm
  // runs under the normal runtime without error (the module IS produced by Pyret-in-WASM)
  await expect(runSelfHostedModule(wasm)).resolves.toBeDefined();
});

test("self-hosted compiler rejects programs outside its subset (triggers the CLI's seed fallback)", async () => {
  // The self-hosted check harness only supports is/is-not, so `is-roughly` throws.
  // (NB: `[list: ...]`, `var`/`:=`, `check:` blocks, `for` loops, `print`, `type`
  // aliases, and `or`/`and` now DO compile self-hosted.)
  await expect(buildSelfHosted("check:\n  4 is-roughly 4\nend")).rejects.toThrow();
  // ...and the seed handles a program, so the fallback always works
  const seed = await buildSource("print(1 + 1)");
  const r = await run(seed);
  expect(r.error).toBeUndefined();
  expect(r.output).toContain("2"); // 1 + 1 computed by the seed
});

test("pyretc run --self-hosted: compiles a literal via the self-hosted compiler (exit 0)", async () => {
  const proc = Bun.spawn(["bun", "run", CLI, "run", "--self-hosted", LIT], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  const err = await new Response(proc.stderr).text();
  expect(code).toBe(0);
  // a literal is in-subset, so NO fallback notice should appear
  expect(err).not.toContain("falling back to seed");
});

test("pyretc run --self-hosted: falls back to the seed for out-of-subset programs", async () => {
  const proc = Bun.spawn(["bun", "run", CLI, "run", "--self-hosted", FALLBACK], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  expect(code).toBe(0);
  expect(err).toContain("falling back to seed"); // it announced the fallback
  expect(out).toContain("5");                     // and the seed produced the right result
});
