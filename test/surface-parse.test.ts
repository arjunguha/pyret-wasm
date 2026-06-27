// End-to-end check of the self-hosted SURFACE PARSER (Option B in
// self-host/parser-plan.md): the seed's JS GLR parser produces a CST, the host
// (parse-bridge.ts) lowers it to a flat pre-order node stream, and the Pyret-side
// deserializer (self-host/parse-from-tree.arr, reached via parse-pyret.arr's
// `surface-parse`) rebuilds real ast.arr AST values from it — verified by running
// a seed-compiled program that calls surface-parse and inspects the result.

import { test, expect } from "bun:test";
import { resolve } from "path";
import { buildSourceFile } from "../src/build.ts";
import { parsePyret } from "../src/parser/pyret-parser.ts";
import { serializeCst } from "../src/runtime/parse-bridge.ts";
import { buildHostImports, newHostState } from "../src/runtime/run.ts";

const FIXTURE = resolve(import.meta.dir, "fixtures/surface-parse.arr");

// Run the fixture with the host bridge primed to parse `src`.
async function runWithSource(wasm: Uint8Array, src: string): Promise<string> {
  const state = newHostState();
  state.sourceBytes = new TextEncoder().encode(src);
  state.parseNodes = serializeCst(await parsePyret(src));
  const imports = buildHostImports(state);
  const { instance } = await WebAssembly.instantiate(wasm as BufferSource, imports);
  state.instance = instance;
  state.memory = instance.exports.memory as WebAssembly.Memory;
  (instance.exports.main as () => void)();
  return state.captured;
}

test("surface-parse: '5' -> s-program / s-block / s-num(5)", async () => {
  const wasm = await buildSourceFile(FIXTURE);
  const out = await runWithSource(wasm, "5");
  // surface-parse("5") -> s-program { block: s-block { stmts: [s-num(5)] } }
  expect(out).toContain("prog=true"); // is-s-program
  expect(out).toContain("blk=true"); // is-s-block
  expect(out).toContain("num=true"); // is-s-num
  expect(out).toContain("n=5"); // the number payload
});

// The CST -> flat-AST lowering itself, exercised directly (no WASM).
test("serializeCst lowers core forms to a flat pre-order stream", async () => {
  // "5" -> program, block, num
  const five = serializeCst(await parsePyret("5"));
  expect(five.map((n) => n.tag)).toEqual([0, 1, 2]); // PROGRAM, BLOCK, NUM
  expect(five[2]!.str).toBe("5");

  // "1 + 2" -> program, block, op(+, num, num)
  const sum = serializeCst(await parsePyret("1 + 2"));
  expect(sum.map((n) => n.tag)).toEqual([0, 1, 6, 2, 2]); // …, OP, NUM, NUM
  expect(sum[2]!.str).toBe("op+");

  // string / bool / id leaves
  expect(serializeCst(await parsePyret('"hi"'))[2]!.str).toBe("hi");
  expect(serializeCst(await parsePyret("true"))[2]!.str).toBe("true");
  expect(serializeCst(await parsePyret("x"))[2]!.str).toBe("x");
});
