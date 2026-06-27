// UI-THREAD runner (no Web Worker). Compiles Pyret and runs it on the main thread
// (required so user code can later do async image loading + JS interop).
//
// Cooperative stoppability is the job of the Pyret→Pyret CPS transform
// (self-host/cps.arr), NOT the TS seed. We run user code through the STOPPABLE
// pipeline: the seed-compiled CPS driver (web/cps-driver.wasm, fetched at runtime)
// transforms the source into continuation-passing form, which the seed compiles
// with {stoppable:true}; the single-thread trampoline (run-stoppable.ts) then
// pauses/resumes it on the event loop so a Stop click is serviced same-thread.
// Programs using syntax the CPS transform doesn't cover yet (or if the driver
// isn't available) fall back to a direct build — they run but aren't stoppable.

import { buildStoppableSourceWith } from "../src/build-stoppable-core.ts";
import { buildSourceWith } from "../src/build-core.ts";
import { parsePyretBrowser } from "../src/parser/parser-browser.ts";
import { run } from "../src/runtime/run.ts";
import { runStoppable } from "../src/runtime/run-stoppable.ts";

export interface RunHandle {
  stop: () => void;
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

async function runProgram(src: string, opts: { stdout: (s: string) => void }): Promise<RunHandle> {
  // Prefer the STOPPABLE (CPS) build so the program is interruptible on the UI
  // thread. Fall back to a direct build if that fails (driver missing / syntax the
  // CPS transform doesn't cover) — it runs but cannot be cooperatively stopped.
  try {
    const wasm = await buildStoppableSourceWith(parsePyretBrowser, src, cpsDriverWasm);
    const h = runStoppable(wasm, { stdout: opts.stdout });
    return { stop: h.stop, promise: h.promise.then((r) => ({
      output: r.output, error: r.error, stopped: r.stopped, pauses: r.pauses, stoppable: true,
    })) };
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
