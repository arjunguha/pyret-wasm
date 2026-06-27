// UI-THREAD runner (no Web Worker). Compiles Pyret with the seed (direct) and
// runs it on the main thread. Running on the UI thread (rather than a Worker) is
// required so user code can later do async image loading and JS interop.
//
// NOTE: cooperative stoppability is the job of the Pyret→Pyret CPS transform
// (self-host/cps.arr), NOT the TS seed. Until that self-hosted transform is wired
// in, the Stop button is a no-op (programs run to completion). The single-thread
// trampoline driver (run-stoppable.ts) + the yield-check runtime primitive remain
// in place for when the Pyret CPS output is used.

import { buildSourceWith } from "../src/build-core.ts";
import { parsePyretBrowser } from "../src/parser/parser-browser.ts";
import { run } from "../src/runtime/run.ts";

export interface RunHandle {
  stop: () => void;
  // resolves when the program finishes, errors, or is stopped
  promise: Promise<{ output: string; error?: string; stopped: boolean; pauses: number; stoppable: boolean }>;
}

async function runProgram(src: string, opts: { stdout: (s: string) => void }): Promise<RunHandle> {
  // Direct (seed) build + run on the UI thread. Cooperative stop will return via
  // the Pyret CPS transform (self-host/cps.arr) once it's wired in.
  const wasm = await buildSourceWith(parsePyretBrowser, src); // may throw a real error -> caller shows it
  const promise = run(wasm, { stdout: opts.stdout }).then((r) => ({
    output: r.output, error: r.error, stopped: false, pauses: 0, stoppable: false,
  }));
  return { stop: () => {}, promise };
}

(window as any).PyretRunner = { run: runProgram };
(window as any).pyretReady = true;
if (typeof (window as any).onPyretReady === "function") (window as any).onPyretReady();
