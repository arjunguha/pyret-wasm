// UI-THREAD runner (no Web Worker). Compiles + runs Pyret on the main thread
// (required so user code can do async image loading + JS interop).
//
// The IDE runs ONLY through ONE artifact: the fully self-hosted, stoppable compile
// driver (web/cps-compile-driver.wasm). It does, ENTIRELY in WASM (no JS parser, no
// seed, no fallback, no JS codegen):
//   source -> pure-Pyret parser -> CPS stoppability transform (yield-check/$do_pause)
//          -> desugar -> ANF -> wasm-of-pyret backend  -> the program's module bytes.
// We then run that module on a single-thread trampoline (driven HERE) with DEBUGGER
// controls — Pause (freeze at the next yield), Resume, single-Step, Stop — built on the
// $do_pause points, serviced same-thread on the event loop.
// This self-hosted stoppable compiler isn't fully ready yet: programs it can't compile
// surface a real error (we deliberately do NOT fall back to the seed). The wiring is
// optimistic — it lights up as the self-hosted compiler's coverage comes online.

// IMPORTANT: the browser bundle must NOT import the SEED compiler (src/compiler/compile.ts
// → binaryen, ~21MB), the JS-GLR parser, or any module that transitively pulls them. The
// ONLY compiler on the web is the prebuilt cps-compile-driver.wasm; the only TS here is the
// host imports + the stoppable trampoline + IDE glue.
import { buildHostImports, newHostState, PauseSignal, PyretError } from "../src/runtime/run.ts";
// The standard prelude (list combinators, the image scene-graph library, …), imported as
// TEXT (no seed compiler is pulled into the browser bundle — see src/compiler/prelude.ts).
// It is PREPENDED to user source and compiled through the same single driver, so programs
// get `map`/`filter`/`circle`/`overlay`/… The line count lets us remap error locations
// back to the user's own line numbers.
import { PRELUDE_SRC } from "../src/compiler/prelude.ts";
const PRELUDE_LINES = PRELUDE_SRC.split("\n").length;

export type RunState = "running" | "paused";

export interface RunHandle {
  stop: () => void;
  pause: () => void;
  resume: () => void;
  step: () => void;
  // resolves when the program finishes, errors, or is stopped
  promise: Promise<{ output: string; error?: string; stopped: boolean; pauses: number; stoppable: boolean }>;
}

// The single stoppable compile driver wasm (built by `bun run build:web` ->
// web/cps-compile-driver.wasm), fetched once. It is the whole compiler written in
// Pyret — pure-Pyret parser + CPS stoppability transform + the Pyret-written backend
// — seed-compiled to WASM. NO JS parser, NO seed, NO separate CPS pass.
let _driver: Promise<Uint8Array> | null = null;
function compileDriverWasm(): Promise<Uint8Array> {
  if (!_driver) {
    _driver = fetch("cps-compile-driver.wasm").then((r) => {
      if (!r.ok) throw new Error("cps-compile-driver.wasm not found");
      return r.arrayBuffer();
    }).then((b) => new Uint8Array(b));
  }
  return _driver;
}

// Compile `src` to a STOPPABLE WASM module via the single self-hosted driver — NO JS,
// NO seed. The driver reads the editor source via read-source() (state.sourceBytes),
// parses it with the pure-Pyret parser, applies the CPS stoppability transform, and
// emits the program's module bytes via emit-byte. Those bytes ARE the program's module,
// produced entirely by Pyret-in-WASM, carrying the yield-check / $do_pause interrupt
// points. Throws if the self-hosted compiler can't compile the program — the caller
// surfaces that error and does NOT fall back to the seed.
async function compileStoppable(src: string): Promise<Uint8Array> {
  const driver = await compileDriverWasm();
  const state = newHostState(() => {}); // discard the compiler's own stdout
  // Prepend the standard prelude so user code sees the stdlib (map/filter/images/…).
  state.sourceBytes = new TextEncoder().encode(PRELUDE_SRC + "\n" + src);
  const { instance } = await WebAssembly.instantiate(driver as BufferSource, buildHostImports(state));
  state.instance = instance;
  const mem = instance.exports.memory as WebAssembly.Memory;
  state.memory = mem;
  // Compiling a large program can allocate a lot; pre-grow linear memory generously.
  const need = state.sourceBytes.length * 16 + (4 << 20);
  const have = mem.buffer.byteLength;
  if (need > have) {
    const want = Math.ceil((need - have) / 65536);
    const room = 512 - Math.ceil(have / 65536);
    if (room > 0) { try { mem.grow(Math.min(want, room)); } catch { /* best effort */ } }
  }
  (instance.exports.main as () => void)(); // runs the driver, emitting the target module's bytes
  if (!state.emitted || state.emitted.length === 0) throw new Error("self-hosted compiler emitted no bytes");
  return new Uint8Array(state.emitted);
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

// Normalize a build-time error. The parser + compiler now live INSIDE the wasm driver,
// so parse/compile errors surface as plain Errors (or PyretError) thrown out of the
// driver's main() — there is no JS ParseError/CompileError type on the web anymore.
function withLocation(e: unknown): Error {
  const err = e instanceof Error ? e : new Error(String(e));
  // User source is compiled as PRELUDE_SRC + "\n" + src, so any 1-based line number the
  // compiler reports is shifted down by the prelude's line count. Remap `line N` (N past
  // the prelude) back to the user's own numbering. (The path emits no line numbers today;
  // this is harmless until it does.)
  if (err.message) {
    err.message = err.message.replace(/\bline (\d+)\b/g, (m, n) => {
      const ln = Number(n);
      return ln > PRELUDE_LINES ? `line ${ln - PRELUDE_LINES}` : m;
    });
  }
  return err;
}

const NOOP = () => {};

const NOOP_HANDLE: Pick<RunHandle, "stop" | "pause" | "resume" | "step"> =
  { stop: NOOP, pause: NOOP, resume: NOOP, step: NOOP };

async function runProgram(
  src: string,
  opts: { stdout: (s: string) => void; onState?: (s: RunState) => void; onPause?: (n: number) => void },
): Promise<RunHandle> {
  // The IDE runs ONLY through ONE artifact: the self-hosted, stoppable compile driver
  // (cps-compile-driver.wasm = pure-Pyret parser + CPS stoppability transform + the
  // Pyret-written backend). NO seed, NO fallback, NO JS parser, NO JS codegen. Then run
  // on the single-thread trampoline (Pause/Step/Resume/Stop). This compiler isn't fully
  // ready yet — programs it can't handle surface a real error (we do NOT silently fall
  // back to the seed). Wired optimistically: it lights up as the compiler's coverage grows.
  let wasm: Uint8Array;
  try {
    wasm = await compileStoppable(src);
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
