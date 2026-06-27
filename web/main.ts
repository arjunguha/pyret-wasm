// UI-THREAD runner (no Web Worker). Compiles Pyret and runs it on the main thread
// (required so user code can later do async image loading + JS interop).
//
// Cooperative stoppability is the job of the Pyret→Pyret CPS transform
// (self-host/cps.arr), NOT the TS seed. We run user code through the STOPPABLE
// pipeline: the seed-compiled CPS driver (web/cps-driver.wasm, fetched at runtime)
// transforms the source into continuation-passing form, which the seed compiles
// with {stoppable:true}; a single-thread trampoline then pauses/resumes it on the
// event loop so a Stop click is serviced same-thread. We drive that trampoline
// HERE (rather than run-stoppable.ts) so we can also offer DEBUGGER controls —
// Pause (freeze at the next yield), Resume, and single-Step — built on the very
// same pause points. Programs using syntax the CPS transform doesn't cover yet (or
// if the driver isn't available) fall back to a direct build — they run but are
// neither stoppable nor pausable.

import { buildStoppableSourceWith } from "../src/build-stoppable-core.ts";
import { buildSourceWith } from "../src/build-core.ts";
import { parsePyretBrowser } from "../src/parser/parser-browser.ts";
import { run, buildHostImports, newHostState, PauseSignal, PyretError } from "../src/runtime/run.ts";
import { ParseError } from "../src/parser/parse-core.ts";
import { CompileError } from "../src/compiler/compile.ts";

export type RunState = "running" | "paused";

export interface RunHandle {
  stop: () => void;
  pause: () => void;
  resume: () => void;
  step: () => void;
  // resolves when the program finishes, errors, or is stopped
  promise: Promise<{ output: string; error?: string; stopped: boolean; pauses: number; stoppable: boolean }>;
}

// The CPS driver wasm (built by `bun run build:web` -> web/cps-driver.wasm), fetched once.
let _driver: Promise<Uint8Array> | null = null;
function cpsDriverWasm(): Promise<Uint8Array> {
  if (!_driver) {
    _driver = fetch("cps-driver.wasm").then((r) => {
      if (!r.ok) throw new Error("cps-driver.wasm not found");
      return r.arrayBuffer();
    }).then((b) => new Uint8Array(b));
  }
  return _driver;
}

interface ControlledOpts {
  stdout?: (s: string) => void;
  onPause?: (n: number) => void;
  onState?: (s: RunState) => void;
}
interface ControlledHandle {
  promise: Promise<{ output: string; error?: string; stopped: boolean; pauses: number }>;
  stop: () => void;
  pause: () => void;
  resume: () => void;
  step: () => void;
}

// Drive the stoppable (CPS) module's trampoline with full debugger control. The
// compiled code throws PauseSignal every GAS_RESET ticks (via the `do_pause` host
// import); between throws we decide whether to continue, yield to the event loop,
// or BLOCK at a gate until the user resumes/steps — all on one thread.
function runControlled(wasm: Uint8Array, opts: ControlledOpts = {}): ControlledHandle {
  let stopRequested = false;
  let paused = false;       // user asked to hold at pause points
  let gate: (() => void) | null = null; // resolver for the blocked-at-pause promise

  const release = () => { if (gate) { const g = gate; gate = null; g(); } };
  const stop = () => { stopRequested = true; release(); };
  const pause = () => { paused = true; };                 // takes hold at the next pause point
  const resume = () => { paused = false; opts.onState?.("running"); release(); };
  const step = () => { release(); };                      // paused stays set: run one interval, hold again

  const promise = (async (): Promise<{ output: string; error?: string; stopped: boolean; pauses: number }> => {
    const state = newHostState(opts.stdout);
    const imports = buildHostImports(state);
    const { instance } = await WebAssembly.instantiate(wasm as BufferSource, imports);
    state.instance = instance;
    state.memory = instance.exports.memory as WebAssembly.Memory;
    const main = instance.exports.main as () => void;
    const resumeFn = instance.exports.resume as () => void;

    let pauses = 0;
    let stepFn: () => void = main;
    while (true) {
      try {
        stepFn();
        return { output: state.captured, stopped: false, pauses };
      } catch (e) {
        if (e instanceof PauseSignal) {
          pauses++;
          opts.onPause?.(pauses);
          if (stopRequested) return { output: state.captured, stopped: true, pauses };
          if (paused) {
            // Held: BLOCK at the gate until resume()/step()/stop(). onState("paused")
            // fires HERE (when actually held), so the UI reflects true state. A step
            // arms exactly one interval (paused stays set → we block again next time).
            opts.onState?.("paused");
            await new Promise<void>((r) => { gate = r; });
            if (stopRequested) return { output: state.captured, stopped: true, pauses };
          } else {
            await new Promise((r) => setTimeout(r, 0)); // yield so the UI/Stop is serviced
            if (stopRequested) return { output: state.captured, stopped: true, pauses };
          }
          stepFn = resumeFn;
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

  return { promise, stop, pause, resume, step };
}

// Augment a build-time error with a clickable source location (the browser path
// otherwise drops the line/col the CLI prints). startLine is 1-based, startCol
// 0-based — the IDE turns "line L, column C" into a clickable cursor jump.
function withLocation(e: unknown): Error {
  if (e instanceof ParseError && e.pos) {
    const err = new Error(`${e.message} (at line ${e.pos.startLine}, column ${e.pos.startCol})`);
    return err;
  }
  if (e instanceof CompileError && (e as any).node?.pos) {
    const p = (e as any).node.pos;
    return new Error(`${e.message} (at line ${p.startLine}, column ${p.startCol})`);
  }
  return e instanceof Error ? e : new Error(String(e));
}

const NOOP = () => {};

async function runProgram(
  src: string,
  opts: { stdout: (s: string) => void; onState?: (s: RunState) => void; onPause?: (n: number) => void },
): Promise<RunHandle> {
  // Prefer the STOPPABLE (CPS) build so the program is interruptible AND pausable
  // on the UI thread. Fall back to a direct build if that fails (driver missing /
  // syntax the CPS transform doesn't cover) — it runs but can't be stopped/paused.
  try {
    const wasm = await buildStoppableSourceWith(parsePyretBrowser, src, cpsDriverWasm);
    const h = runControlled(wasm, { stdout: opts.stdout, onState: opts.onState, onPause: opts.onPause });
    return {
      stop: h.stop, pause: h.pause, resume: h.resume, step: h.step,
      promise: h.promise.then((r) => ({
        output: r.output, error: r.error, stopped: r.stopped, pauses: r.pauses, stoppable: true,
      })),
    };
  } catch (_e) {
    let wasm: Uint8Array;
    try {
      wasm = await buildSourceWith(parsePyretBrowser, src);
    } catch (buildErr) {
      throw withLocation(buildErr); // real compile/parse error -> caller shows it (with location)
    }
    const promise = run(wasm, { stdout: opts.stdout }).then((r) => ({
      output: r.output, error: r.error, stopped: false, pauses: 0, stoppable: false,
    }));
    return { stop: NOOP, pause: NOOP, resume: NOOP, step: NOOP, promise };
  }
}

(window as any).PyretRunner = { run: runProgram };
(window as any).pyretReady = true;
if (typeof (window as any).onPyretReady === "function") (window as any).onPyretReady();
