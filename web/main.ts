// UI-THREAD runner (no Web Worker). Compiles + runs Pyret on the main thread
// (required so user code can do async image loading + JS interop).
//
// The IDE runs ONLY through the fully self-hosted, stoppable compiler — the
// deployable artifact: the Pyret-in-Pyret compiler (web/selfhost-driver.wasm) plus
// the Pyret→Pyret CPS stoppability transform (web/cps-driver.wasm). There is NO
// seed path, NO fallback, NO JS codegen. Run pipeline:
//   1. CPS-transform (prelude + user code) → continuation-passing Pyret SOURCE,
//      via the seed-compiled CPS driver (self-host/cps.arr) — inserts the
//      yield-check/$do_pause points.
//   2. Compile that source with the SELF-HOSTED compiler (self-host/compile-driver.arr,
//      which parses with the no-JS Pyret parser and emits WASM via wasm-of-pyret) →
//      the program's module bytes.
//   3. Run on a single-thread trampoline (driven HERE) with DEBUGGER controls —
//      Pause (freeze at the next yield), Resume, single-Step, Stop — built on the
//      $do_pause points, serviced same-thread on the event loop.
// This self-hosted stoppable compiler isn't fully ready yet: programs it can't compile
// surface a real error (we deliberately do NOT fall back to the seed). The wiring is
// optimistic — it lights up as the self-hosted compiler's coverage + stoppable codegen
// come online.

import { serializeCstNode } from "../src/build-stoppable-core.ts";
import { PRELUDE_SRC } from "../src/compiler/prelude.ts";
import { parsePyretBrowser } from "../src/parser/parser-browser.ts";
import { buildHostImports, newHostState, PauseSignal, PyretError } from "../src/runtime/run.ts";
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

// The SELF-HOSTED compiler driver wasm (built by `bun run build:web` ->
// web/selfhost-driver.wasm), fetched once. This is the real compiler written in
// Pyret (front-end + Pyret-written backend), seed-compiled to WASM.
let _shDriver: Promise<Uint8Array> | null = null;
function selfhostDriverWasm(): Promise<Uint8Array> {
  if (!_shDriver) {
    _shDriver = fetch("selfhost-driver.wasm").then((r) => {
      if (!r.ok) throw new Error("selfhost-driver.wasm not found");
      return r.arrayBuffer();
    }).then((b) => new Uint8Array(b));
  }
  return _shDriver;
}

// Compile `src` with the SELF-HOSTED compiler — NO JS, NO seed. Run the seed-compiled
// driver on the source (handed to it via read-source() / sourceBytes; surface-parse is
// the no-JS Pyret parser, so no JS parser is involved), collecting the WASM bytes it
// emits via `emit-byte`. Those bytes ARE the program's module, produced entirely by
// Pyret-in-WASM. Throws if the self-hosted compiler can't compile the program — the
// caller surfaces that error and does NOT fall back to the seed.
async function compileSelfHosted(src: string): Promise<Uint8Array> {
  const driver = await selfhostDriverWasm();
  const state = newHostState(() => {}); // discard the compiler's own stdout
  state.sourceBytes = new TextEncoder().encode(src);
  const { instance } = await WebAssembly.instantiate(driver as BufferSource, buildHostImports(state));
  state.instance = instance;
  state.memory = instance.exports.memory as WebAssembly.Memory;
  (instance.exports.main as () => void)(); // runs the driver, emitting the target module's bytes
  if (!state.emitted || state.emitted.length === 0) throw new Error("self-hosted compiler emitted no bytes");
  return new Uint8Array(state.emitted);
}

// CPS-transform (prelude + user code, together) into continuation-passing Pyret
// SOURCE, via the seed-compiled CPS driver (self-host/cps.arr). The transformed
// source carries the yield-check / $do_pause calls that make it cooperatively
// stoppable; we then hand that source to the self-hosted compiler.
async function cpsTransform(src: string): Promise<string> {
  const program = await parsePyretBrowser(PRELUDE_SRC + "\n" + src);
  const serialized = serializeCstNode(program);
  const driver = await cpsDriverWasm();
  const state = newHostState();
  state.sourceBytes = new TextEncoder().encode(serialized);
  const { instance } = await WebAssembly.instantiate(driver as BufferSource, buildHostImports(state));
  state.instance = instance;
  const mem = instance.exports.memory as WebAssembly.Memory;
  state.memory = mem;
  // The serialized CST is large (prelude alone ~285KB); pre-grow linear memory.
  const need = state.sourceBytes.length * 8 + (2 << 20);
  const have = mem.buffer.byteLength;
  if (need > have) {
    const want = Math.ceil((need - have) / 65536);
    const room = 256 - Math.ceil(have / 65536);
    if (room > 0) { try { mem.grow(Math.min(want, room)); } catch { /* best effort */ } }
  }
  (instance.exports.main as () => void)();
  return state.captured.trim();
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

const NOOP_HANDLE: Pick<RunHandle, "stop" | "pause" | "resume" | "step"> =
  { stop: NOOP, pause: NOOP, resume: NOOP, step: NOOP };

async function runProgram(
  src: string,
  opts: { stdout: (s: string) => void; onState?: (s: RunState) => void; onPause?: (n: number) => void },
): Promise<RunHandle> {
  // The IDE runs ONLY through the fully self-hosted, stoppable compiler — the
  // deployable artifact (the Pyret-in-Pyret compiler + the CPS stoppability
  // transform). NO seed, NO fallback, NO JS codegen. Pipeline:
  //   1. CPS-transform (prelude + user) -> continuation-passing Pyret source (cps.arr),
  //   2. compile that source with the SELF-HOSTED compiler (compile-driver.arr),
  //   3. run on the single-thread trampoline (Pause/Step/Resume/Stop).
  // This compiler isn't fully ready yet — programs it can't handle surface a real
  // error (we do NOT silently fall back to the seed). Wired optimistically: it lights
  // up as the self-hosted compiler's coverage + stoppable codegen come online.
  let wasm: Uint8Array;
  try {
    const transformed = await cpsTransform(src);
    wasm = await compileSelfHosted(transformed);
  } catch (buildErr) {
    throw withLocation(buildErr); // real compile/parse error -> caller shows it (with location)
  }
  const h = runControlled(wasm, { stdout: opts.stdout, onState: opts.onState, onPause: opts.onPause });
  return {
    ...NOOP_HANDLE,
    stop: h.stop, pause: h.pause, resume: h.resume, step: h.step,
    promise: h.promise.then((r) => ({
      output: r.output, error: r.error, stopped: r.stopped, pauses: r.pauses, stoppable: true,
    })),
  };
}

(window as any).PyretRunner = { run: runProgram };
(window as any).pyretReady = true;
if (typeof (window as any).onPyretReady === "function") (window as any).onPyretReady();
