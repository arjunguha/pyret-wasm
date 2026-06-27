// Host harness: instantiate a compiled Pyret module and run its `main`.
// The JS glue is intentionally minimal — only the I/O boundary lives here.

import type { SerNode } from "./parse-bridge.ts";

export interface RunResult {
  output: string;
  error?: string;
  emitted?: Uint8Array; // bytes produced via emit-byte (the Pyret WASM encoder)
}

// A Pyret runtime error, thrown from the host `raise` import and unwound
// through the WASM frames (no WASM exception-handling proposal needed).
export class PyretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PyretError";
  }
}

// Thrown by the `do_pause` host import to unwind a stoppable (CPS) computation
// back to the trampoline driver. Never thrown during a plain `run`.
export class PauseSignal extends Error {
  constructor() {
    super("pause");
    this.name = "PauseSignal";
  }
}

// Mutable host-side state shared between the import callbacks and the driver.
export interface HostState {
  memory: WebAssembly.Memory | null;
  instance: WebAssembly.Instance | null;
  captured: string;
  failures: number;
  emitted: number[];
  stdout: (s: string) => void;
  // program source bytes, written into WASM memory on demand by the
  // `read_source_into` import (the self-hosted compiler's input). Empty otherwise.
  sourceBytes: Uint8Array;
  // Flat pre-order parse-tree (CST lowered by parse-bridge.serializeCst), exposed
  // to the self-hosted parser via the `parse_*` imports. Either precomputed by the
  // caller, or produced lazily from `sourceBytes` by `parseSource` (below) on the
  // first `parse_source` call; empty until then.
  parseNodes: SerNode[];
  // Optional lazy parser: decode+parse+serialize a source string into a node
  // stream. When set and `parseNodes` is still empty, the `parse_source` import
  // parses `sourceBytes` on demand — so callers need only set `sourceBytes` (the
  // same buffer `read-source` delivers), not precompute the CST. Kept as a
  // callback so run.ts stays parser-agnostic (no static GLR import -> browser-safe).
  parseSource?: (src: string) => SerNode[];
}

// Build the `host` import object. The same set is used by `run` and the
// stoppable trampoline driver; `do_pause` throws PauseSignal to unwind to JS.
export function buildHostImports(state: HostState) {
  const decoder = new TextDecoder();
  const readString = (ptr: number, len: number): string =>
    decoder.decode(new Uint8Array(state.memory!.buffer, ptr, len));
  let stashedLhs = "";
  // Grow linear memory so a write covering [0, end) fits. The module declares a
  // bounded maximum (seed: setMemory(1, 256)); growth past it leaves the write to
  // throw a clear "Length out of range" error. Large self-hosted inputs (e.g. the
  // compiler's own ~130KB source files via read-source) need more than the 1-page
  // initial, so callers no longer have to pre-grow `state.memory` themselves.
  const ensureCapacity = (end: number): void => {
    const mem = state.memory!;
    if (end > mem.buffer.byteLength) {
      const pages = Math.ceil((end - mem.buffer.byteLength) / 65536);
      try { mem.grow(pages); } catch { /* exceeds declared max; the write surfaces the error */ }
    }
  };
  return {
    host: {
      emit_byte: (b: number) => { state.emitted.push(b & 0xff); },
      check_raises: (ptr: number, len: number): number => {
        const expected = readString(ptr, len);
        try {
          (state.instance!.exports.run_pending_thunk as () => unknown)();
          return 0;
        } catch (e) {
          if (e instanceof PyretError) return e.message.includes(expected) ? 1 : 0;
          throw e;
        }
      },
      print: (ptr: number, len: number) => { state.stdout(readString(ptr, len) + "\n"); },
      check_stash: (ptr: number, len: number) => { stashedLhs = readString(ptr, len); },
      check_fail: (ptr: number, len: number) => {
        state.failures++;
        state.stdout(`  test failed: ${stashedLhs} is ${readString(ptr, len)}\n`);
      },
      check_fail_isnot: (ptr: number, len: number) => {
        state.failures++;
        state.stdout(`  test failed: ${stashedLhs} is-not ${readString(ptr, len)} (they were equal)\n`);
      },
      check_fail_pred: () => {
        state.failures++;
        state.stdout(`  test failed: predicate not satisfied\n`);
      },
      raise: (ptr: number, len: number) => { throw new PyretError(readString(ptr, len)); },
      do_pause: () => { throw new PauseSignal(); },
      read_source_into: (addr: number): number => {
        ensureCapacity(addr + state.sourceBytes.length);
        new Uint8Array(state.memory!.buffer, addr, state.sourceBytes.length).set(state.sourceBytes);
        return state.sourceBytes.length;
      },
      // Self-hosted parser bridge (Option B): the CST is a flat pre-order stream
      // in state.parseNodes; these four imports let the Pyret side walk it with a
      // cursor (no in-WASM string-stream parsing). See parse-bridge.ts. The stream
      // is either precomputed by the caller, or parsed on demand here from
      // sourceBytes via state.parseSource (so callers can set just sourceBytes).
      parse_source: (): number => {
        if (state.parseNodes.length === 0 && state.parseSource && state.sourceBytes.length > 0) {
          state.parseNodes = state.parseSource(decoder.decode(state.sourceBytes));
        }
        return state.parseNodes.length;
      },
      parse_node_tag: (i: number): number => state.parseNodes[i]!.tag,
      parse_node_nkids: (i: number): number => state.parseNodes[i]!.nkids,
      parse_node_str_into: (i: number, addr: number): number => {
        const bytes = new TextEncoder().encode(state.parseNodes[i]!.str);
        ensureCapacity(addr + bytes.length);
        new Uint8Array(state.memory!.buffer, addr, bytes.length).set(bytes);
        return bytes.length;
      },
      // Transcendental math via JS Math (no native WASM ops). op codes mirror runtime.ts.
      math1: (op: number, x: number): number => {
        switch (op) {
          case 0: return Math.exp(x);
          case 1: return Math.log(x);
          case 2: return Math.sin(x);
          case 3: return Math.cos(x);
          case 4: return Math.tan(x);
          case 5: return Math.atan(x);
          case 6: return Math.asin(x);
          case 7: return Math.acos(x);
          default: return NaN;
        }
      },
      math2: (op: number, x: number, y: number): number => (op === 0 ? Math.atan2(x, y) : NaN),
      check_summary: (passed: number, total: number) => {
        if (total === 0) return;
        if (passed === total) {
          state.stdout(total === 1
            ? "Looks shipshape, your 1 test passed, mate!\n"
            : `Looks shipshape, all ${total} tests passed, mate!\n`);
        } else {
          state.stdout(`Test results: ${passed} passed, ${total - passed} failed (out of ${total}).\n`);
        }
      },
    },
  };
}

export function newHostState(stdout?: (s: string) => void): HostState {
  const state: HostState = {
    memory: null, instance: null, captured: "", failures: 0, emitted: [],
    stdout: stdout ?? ((s: string) => { state.captured += s; }),
    sourceBytes: new Uint8Array(0),
    parseNodes: [],
  };
  return state;
}

export async function run(wasm: Uint8Array, opts: { stdout?: (s: string) => void } = {}): Promise<RunResult> {
  const state = newHostState(opts.stdout);
  const imports = buildHostImports(state);
  const { instance } = await WebAssembly.instantiate(wasm as BufferSource, imports);
  state.instance = instance;
  state.memory = instance.exports.memory as WebAssembly.Memory;
  try {
    (instance.exports.main as () => void)();
  } catch (e) {
    if (e instanceof PyretError) {
      state.stdout(e.message + "\n");
      return { output: state.captured, error: e.message, emitted: new Uint8Array(state.emitted) };
    }
    throw e;
  }
  return { output: state.captured, emitted: new Uint8Array(state.emitted) };
}
