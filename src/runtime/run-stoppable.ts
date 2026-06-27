// Single-thread trampoline driver for stoppable (CPS) Pyret code.
//
// No Web Worker: user code runs on the same thread as the driver. The compiled
// code pauses itself (via the `do_pause` host import, which throws PauseSignal)
// every GAS_RESET ticks; we catch that, optionally yield to the event loop so
// the UI / a Stop click can be serviced, then call the exported `resume` to
// continue from the captured continuation. A requested stop simply declines to
// resume — the computation is abandoned and its heap is GC'd.

import { buildHostImports, newHostState, PauseSignal, PyretError } from "./run.ts";

export interface StoppableResult {
  output: string;
  error?: string;
  stopped: boolean;
  pauses: number;
}

export interface StoppableHandle {
  promise: Promise<StoppableResult>;
  stop: () => void;
}

export interface StoppableOpts {
  stdout?: (s: string) => void;
  // called after each pause (1-based count); a hook for tests / instrumentation
  onPause?: (n: number) => void;
  // if true, do NOT yield to the event loop between resumes (faster for
  // benchmarking throughput; the loop still stays interruptible via onPause/stop)
  noYield?: boolean;
}

export function runStoppable(wasm: Uint8Array, opts: StoppableOpts = {}): StoppableHandle {
  let stopRequested = false;
  const stop = () => { stopRequested = true; };

  const promise = (async (): Promise<StoppableResult> => {
    const state = newHostState(opts.stdout);
    const imports = buildHostImports(state);
    const { instance } = await WebAssembly.instantiate(wasm as BufferSource, imports);
    state.instance = instance;
    state.memory = instance.exports.memory as WebAssembly.Memory;
    const main = instance.exports.main as () => void;
    const resume = instance.exports.resume as () => void;

    let pauses = 0;
    let step: () => void = main;
    while (true) {
      try {
        step();
        return { output: state.captured, stopped: false, pauses };
      } catch (e) {
        if (e instanceof PauseSignal) {
          pauses++;
          opts.onPause?.(pauses);
          if (stopRequested) return { output: state.captured, stopped: true, pauses };
          if (!opts.noYield) await new Promise((r) => setTimeout(r, 0));
          if (stopRequested) return { output: state.captured, stopped: true, pauses };
          step = resume;
          continue;
        }
        if (e instanceof PyretError) {
          state.stdout(e.message + "\n");
          return { output: state.captured, error: e.message, stopped: false, pauses };
        }
        throw e;
      }
    }
  })();

  return { promise, stop };
}
