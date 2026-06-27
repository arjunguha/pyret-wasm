// UI-THREAD runner (no Web Worker). Compiles Pyret with the CPS *stoppable*
// pipeline and runs it on the main thread via the single-thread trampoline
// driver: the compiled code periodically yields to the event loop (so the page
// stays responsive and a Stop click is serviced on the SAME thread), then
// resumes — or, if Stop was requested, abandons the computation.
//
// Running on the UI thread (rather than a Worker) is required so user code can
// later do async image loading and JS interop. The Stop button is cooperative
// (a flag checked at each yield), replacing the old worker.terminate() hard kill.
//
// Programs using syntax the CPS pass doesn't cover yet (e.g. `check` blocks)
// fall back to a direct (non-stoppable) build so they still run.

import { buildStoppableSourceWith } from "../src/build-stoppable-core.ts";
import { buildSourceWith } from "../src/build-core.ts";
import { parsePyretBrowser } from "../src/parser/parser-browser.ts";
import { runStoppable } from "../src/runtime/run-stoppable.ts";
import { run } from "../src/runtime/run.ts";

export interface RunHandle {
  stop: () => void;
  // resolves when the program finishes, errors, or is stopped
  promise: Promise<{ output: string; error?: string; stopped: boolean; pauses: number; stoppable: boolean }>;
}

async function runProgram(src: string, opts: { stdout: (s: string) => void }): Promise<RunHandle> {
  // Prefer the stoppable (CPS) build so the program is interruptible on the UI
  // thread. If that build fails (unsupported syntax), fall back to a direct
  // build — it runs but cannot be cooperatively stopped.
  try {
    const wasm = await buildStoppableSourceWith(parsePyretBrowser, src);
    const h = runStoppable(wasm, { stdout: opts.stdout });
    return { stop: h.stop, promise: h.promise.then((r) => ({ ...r, stoppable: true })) };
  } catch (_e) {
    const wasm = await buildSourceWith(parsePyretBrowser, src); // may throw a real error -> caller shows it
    const promise = run(wasm, { stdout: opts.stdout }).then((r) => ({
      output: r.output, error: r.error, stopped: false, pauses: 0, stoppable: false,
    }));
    return { stop: () => {}, promise };
  }
}

(window as any).PyretRunner = { run: runProgram };
(window as any).pyretReady = true;
if (typeof (window as any).onPyretReady === "function") (window as any).onPyretReady();
