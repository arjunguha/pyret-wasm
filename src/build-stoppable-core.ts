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

export type ParseFn = (src: string) => Promise<CstNode>;

// Serialize a CST to a length-prefixed pre-order string the Pyret driver reads
// back (see read-node in self-host/cps-driver.arr — the two MUST stay in sync).
// Per node: "<nkids> <nameLen> <name><hasVal>[<valLen> <value>]" then its kids.
// Lengths are in Unicode code points (string values may be non-ASCII).
export function serializeCstNode(n: CstNode): string {
  const cps = (s: string) => [...s].length;
  let out = `${n.kids.length} ${cps(n.name)} ${n.name}`;
  if (n.value === undefined || n.value === null) out += "0";
  else out += `1${cps(n.value)} ${n.value}`;
  for (const k of n.kids) out += serializeCstNode(k);
  return out;
}

// Run the CPS driver wasm on the serialized CST; returns the transformed source.
async function runCpsDriver(driverWasm: Uint8Array, serialized: string): Promise<string> {
  const state = newHostState();
  state.sourceBytes = new TextEncoder().encode(serialized);
  const imports = buildHostImports(state);
  const { instance } = await WebAssembly.instantiate(driverWasm as BufferSource, imports);
  state.instance = instance;
  state.memory = instance.exports.memory as WebAssembly.Memory;
  (instance.exports.main as () => void)();
  return state.captured;
}

export async function buildStoppableSourceWith(
  parse: ParseFn,
  src: string,
  getDriverWasm: () => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const userProgram = await parse(src);
  const serialized = serializeCstNode(userProgram);
  const driver = await getDriverWasm();
  const transformed = (await runCpsDriver(driver, serialized)).trim();
  // The prelude is prepended UNTRANSFORMED; user functions are CPS-transformed.
  // (Transforming the prelude too — so its HOFs are interruptible — needs cps.arr
  // to cover every prelude construct; tracked as the next step.)
  const full = await parse(PRELUDE_SRC + "\n" + transformed);
  return compile(full, { stoppable: true });
}
