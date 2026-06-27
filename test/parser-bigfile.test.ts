// run.ts grows WASM linear memory on demand, so the host can deliver large
// `read-source` payloads (the self-hosted compiler's own ~130KB source files)
// without the caller pre-growing memory and without hitting
// "Length out of range of buffer".
//
// This is the MEMORY half of letting the pure-Pyret parser read the biggest
// compiler files. The 3 largest (resolve-scope/type-check/ast.arr) additionally
// need the parser's recursion to be constant-stack — with enough memory they now
// fail with "Maximum call stack size exceeded" inside pyret-parser.arr instead of
// the old memory error; that tail-recursion work is tracked separately (the parser
// lane owns self-host/pyret-parser.arr). So this test isolates the memory fix with
// a tiny probe that READS a large source (no parsing → no stack growth).

import { test, expect } from "bun:test";
import { buildSourceFile } from "../src/build.ts";
import { newHostState, buildHostImports } from "../src/runtime/run.ts";
import { resolve } from "path";

const PROBE = resolve(import.meta.dir, "fixtures/read-source-len.arr");

test("read-source auto-grows linear memory for a large (>64KB) source", async () => {
  const wasm = await buildSourceFile(PROBE);
  // ~200KB — far past the 1-page (64KB) initial linear memory, i.e. bigger than
  // ast.arr (132KB). Before the fix this threw "Length out of range of buffer".
  const big = "x".repeat(200_000);
  const state = newHostState();
  state.sourceBytes = new TextEncoder().encode(big);
  const { instance } = await WebAssembly.instantiate(wasm as BufferSource, buildHostImports(state));
  state.instance = instance;
  state.memory = instance.exports.memory as WebAssembly.Memory;
  expect(state.memory.buffer.byteLength).toBe(65_536); // starts at 1 page
  // NO manual memory.grow here — run.ts must grow on demand inside read_source_into.
  (instance.exports.main as () => void)();
  expect(state.captured).toContain("200000");          // read the whole source + measured it
  expect(state.memory.buffer.byteLength).toBeGreaterThan(65_536); // it grew
});
