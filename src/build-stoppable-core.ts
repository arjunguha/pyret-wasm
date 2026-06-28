// Parser-agnostic STOPPABLE build path. The CPS source-to-source transform that
// makes user code cooperatively interruptible is the Pyret program
// `self-host/cps.arr` (compiled to WASM by the seed) — NOT the TS seed. Here we:
//   1. parse the user source -> CST,
//   2. serialize that CST to a length-prefixed string,
//   3. run the seed-compiled CPS driver (cps-driver.arr) on it: the driver
//      deserializes the CST, runs `cps-transform`, and prints the transformed
//      (continuation-passing) Pyret source,
//   4. re-parse (prelude + transformed user source) and compile with the seed's
//      `{stoppable: true}` codegen (which lowers the yield-check/finish-result
//      intrinsics the CPS output calls, + the $do_pause host import).
// The result runs under the run-stoppable.ts trampoline (pause/resume on one thread).
//
// Node and the browser supply their own parser + a way to obtain the driver wasm,
// so this core stays free of Node-only deps.
import { compile } from "./compiler/compile.ts";
import { PRELUDE_SRC } from "./compiler/prelude.ts";
import { newHostState, buildHostImports } from "./runtime/run.ts";
import type { CstNode } from "./parser/parse-core.ts";
import { serializeCstNode } from "./cst-serialize.ts";

export type ParseFn = (src: string) => Promise<CstNode>;

// serializeCstNode now lives in ./cst-serialize.ts (browser-safe — no compile import);
// re-exported here so existing Node callers keep working.
export { serializeCstNode };

// Run the CPS driver wasm on the serialized CST; returns the transformed source.
async function runCpsDriver(driverWasm: Uint8Array, serialized: string): Promise<string> {
  const state = newHostState();
  state.sourceBytes = new TextEncoder().encode(serialized);
  const imports = buildHostImports(state);
  const { instance } = await WebAssembly.instantiate(driverWasm as BufferSource, imports);
  state.instance = instance;
  const mem = instance.exports.memory as WebAssembly.Memory;
  state.memory = mem;
  // The serialized CST is large (the prelude alone is ~285KB), and the driver reads
  // it into linear memory and builds the CST + output string there. The seed's bump
  // allocator doesn't grow memory itself, so pre-grow to fit (seed max = 256 pages).
  const need = state.sourceBytes.length * 8 + (2 << 20);
  const have = mem.buffer.byteLength;
  if (need > have) {
    const want = Math.ceil((need - have) / 65536);
    const room = 256 - Math.ceil(have / 65536);
    if (room > 0) { try { mem.grow(Math.min(want, room)); } catch { /* best effort */ } }
  }
  (instance.exports.main as () => void)();
  return state.captured;
}

export async function buildStoppableSourceWith(
  parse: ParseFn,
  src: string,
  getDriverWasm: () => Promise<Uint8Array>,
): Promise<Uint8Array> {
  // CPS-transform the prelude TOGETHER with user code (one program) so the stdlib's
  // higher-order functions (map/each/foldl/filter/range/for) are themselves
  // interruptible — a CPS'd user callback flows through a CPS'd `each`, and the
  // yield-check at each loop step lets a Stop click be serviced. (Pyret's
  // tokenizer/parser are stateful singletons, so parse sequentially.)
  const program = await parse(PRELUDE_SRC + "\n" + src);
  const serialized = serializeCstNode(program);
  const driver = await getDriverWasm();
  const transformed = (await runCpsDriver(driver, serialized)).trim();
  // `transformed` already contains the CPS'd prelude + user code — do NOT re-prepend.
  const full = await parse(transformed);
  return compile(full, { stoppable: true });
}
