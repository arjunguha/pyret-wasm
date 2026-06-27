// Host harness: instantiate a compiled Pyret module and run its `main`.
// The JS glue is intentionally minimal — only the I/O boundary lives here.

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
}

// Build the `host` import object. The same set is used by `run` and the
// stoppable trampoline driver; `do_pause` throws PauseSignal to unwind to JS.
export function buildHostImports(state: HostState) {
  const decoder = new TextDecoder();
  const readString = (ptr: number, len: number): string =>
    decoder.decode(new Uint8Array(state.memory!.buffer, ptr, len));
  let stashedLhs = "";
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
        new Uint8Array(state.memory!.buffer, addr, state.sourceBytes.length).set(state.sourceBytes);
        return state.sourceBytes.length;
      },
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
