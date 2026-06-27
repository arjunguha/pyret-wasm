#!/usr/bin/env bun
// pyretc — Pyret-on-WebAssembly command line.

import { ParseError } from "./parser/pyret-parser.ts";
import { CompileError } from "./compiler/compile.ts";
import { buildSource, buildSourceFile } from "./build.ts";
import { run } from "./runtime/run.ts";
import { buildSourceSelfHosted, runSelfHostedModule } from "./build-selfhosted.ts";

function usage(): never {
  console.error("usage: pyretc run [--self-hosted] <file.arr>");
  console.error("       pyretc compile <file.arr> [-o out.wasm]");
  process.exit(2);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) usage();

  if (cmd === "run") {
    const selfHosted = rest.includes("--self-hosted");
    const file = rest.filter((a) => a !== "--self-hosted")[0];
    if (!file) usage();
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
