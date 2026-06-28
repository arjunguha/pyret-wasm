#!/usr/bin/env bun
// pyretc — Pyret-on-WebAssembly command line.

import { ParseError } from "./parser/pyret-parser.ts";
import { CompileError } from "./compiler/compile.ts";
import { buildSource, buildSourceFile } from "./build.ts";
import { run, buildHostImports, newHostState, PauseSignal, PyretError } from "./runtime/run.ts";
import { buildSourceSelfHosted, runSelfHostedModule } from "./build-selfhosted.ts";
import { PRELUDE_SRC } from "./compiler/prelude.ts";
import { resolve } from "path";

function usage(): never {
  console.error("usage: pyretc run [--self-hosted] [--stoppable] <file.arr>");
  console.error("       pyretc compile <file.arr> [-o out.wasm]");
  process.exit(2);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) usage();

  if (cmd === "run") {
    const selfHosted = rest.includes("--self-hosted");
    const stoppable = rest.includes("--stoppable");
    const file = rest.filter((a) => a !== "--self-hosted" && a !== "--stoppable")[0];
    if (!file) usage();

    // --stoppable: compile through the prebuilt CPS driver (web/cps-compile-driver.wasm —
    // the SAME artifact the web IDE ships: self-hosted Pyret compiler + CPS transform,
    // fully in WASM), then run the emitted module with an immediate-resume trampoline
    // (no event-loop yield — raw throughput). Deep non-tail recursion that overflows the
    // direct path runs here because the CPS transform turns it into native tail calls.
    if (stoppable) {
      const driverPath = resolve(import.meta.dir, "..", "web", "cps-compile-driver.wasm");
      let driver: Uint8Array;
      try {
        driver = new Uint8Array(await Bun.file(driverPath).arrayBuffer());
      } catch {
        console.error(`web/cps-compile-driver.wasm not found at ${driverPath}. Rebuild: bun scripts/gen-cps-compile-driver.ts`);
        process.exit(1);
      }
      let src: string;
      try { src = await Bun.file(file).text(); } catch { console.error(`cannot read ${file}`); process.exit(1); }
      // Compile through the CPS driver (prelude prepended, same as web IDE).
      const compState = newHostState(() => {});
      compState.sourceBytes = new TextEncoder().encode(PRELUDE_SRC + "\n" + src);
      const { instance: compInst } = await WebAssembly.instantiate(driver as BufferSource, buildHostImports(compState));
      compState.instance = compInst;
      const compMem = compInst.exports.memory as WebAssembly.Memory;
      compState.memory = compMem;
      const need = compState.sourceBytes.length * 16 + (8 << 20);
      const have = compMem.buffer.byteLength;
      if (need > have) {
        const pages = Math.ceil((need - have) / 65536);
        try { compMem.grow(pages); } catch { /* best effort */ }
      }
      try {
        (compInst.exports.main as () => void)();
      } catch (e) {
        console.error(`compile error: ${(e as Error).message ?? e}`);
        process.exit(1);
      }
      if (!compState.emitted || compState.emitted.length === 0) {
        console.error("CPS driver emitted no bytes");
        process.exit(1);
      }
      const wasm = new Uint8Array(compState.emitted);
      // Run with immediate-resume trampoline (no event-loop yield).
      const runState = newHostState((s) => process.stdout.write(s));
      const { instance: runInst } = await WebAssembly.instantiate(wasm as BufferSource, buildHostImports(runState));
      runState.instance = runInst;
      runState.memory = runInst.exports.memory as WebAssembly.Memory;
      const resumeFn = runInst.exports.resume as (() => void) | undefined;
      let step: () => void = runInst.exports.main as () => void;
      for (;;) {
        try {
          step();
          break;
        } catch (e) {
          if (e instanceof PauseSignal) { step = resumeFn!; continue; }
          if (e instanceof PyretError) { console.error(e.message); process.exit(1); }
          throw e;
        }
      }
      return;
    }

    // --self-hosted: compile with the Pyret-written compiler (compiled to WASM by
    // the seed). Falls back to the seed for programs outside its current subset.
    if (selfHosted) {
      try {
        const src = await Bun.file(file).text();
        const wasm = await buildSourceSelfHosted(src);
        await runSelfHostedModule(wasm, { stdout: (s) => process.stdout.write(s) });
        return;
      } catch (e) {
        console.error(`[self-hosted compiler can't handle this program; falling back to seed: ${(e as Error).message ?? e}]`);
      }
    }
    try {
      const wasm = await buildSourceFile(file);
      const { output } = await run(wasm, { stdout: (s) => process.stdout.write(s) });
      void output;
    } catch (e) {
      reportError(e, file);
      process.exit(1);
    }
    return;
  }

  if (cmd === "compile") {
    const file = rest[0];
    if (!file) usage();
    const outIdx = rest.indexOf("-o");
    const out = outIdx >= 0 ? rest[outIdx + 1]! : file.replace(/\.arr$/, "") + ".wasm";
    try {
      const wasm = await buildSourceFile(file);
      await Bun.write(out, wasm);
      console.error(`wrote ${out} (${wasm.length} bytes)`);
    } catch (e) {
      reportError(e, file);
      process.exit(1);
    }
    return;
  }

  usage();
}

function reportError(e: unknown, file: string) {
  if (e instanceof ParseError) {
    const at = e.pos ? ` at ${file}:${e.pos.startLine}:${e.pos.startCol}` : "";
    console.error(`parse error${at}: ${e.message}`);
  } else if (e instanceof CompileError) {
    const at = e.node ? ` at ${file}:${e.node.pos.startLine}:${e.node.pos.startCol}` : "";
    console.error(`compile error${at}: ${e.message}`);
  } else {
    console.error(String(e));
  }
}

main();
