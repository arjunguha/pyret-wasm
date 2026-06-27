#!/usr/bin/env bun
// SELF-HOSTING FIXPOINT harness — the definition of "done" for the self-hosted
// Pyret->WASM compiler, and a progress meter toward it.
//
//   Stage A:  seed compiles selfhost/compiler.arr (+ modules) -> compiler.wasm
//   Stage B:  compiler.wasm compiles its OWN source           -> compiler2.wasm
//   Stage C:  compiler2.wasm compiles that same source        -> compiler3.wasm
//   FIXPOINT: B == C byte-for-byte (the self-hosted compiler reproduces itself).
//             (We also report A == B, the stronger "seed output already a fixpoint".)
//
// Until the self-hosted compiler supports every feature its own source uses
// (data/cases, lists, strings, ...), Stage B fails — this script reports exactly
// where, so we know what to implement next.
//
// usage: bun scripts/selfhost-fixpoint.ts

import { compileSelfHostCompiler, compileWithModule } from "../src/build-selfhost.ts";
import { resolve } from "path";

const SELF = resolve(import.meta.dir, "../selfhost");
// The compiler's own source = its modules inlined (the program the seed compiles),
// minus module mechanics (provide/include) the single translation unit doesn't need.
const MODULES = ["encoder.arr", "ast.arr", "lexer.arr", "parser.arr", "codegen.arr"];
async function ownSource(): Promise<string> {
  const parts: string[] = [];
  for (const m of MODULES) parts.push(await Bun.file(resolve(SELF, m)).text());
  // compile-source + (no read-source entry; the fixpoint compiles the compiler as data)
  parts.push(`fun compile-source(src):\n  compile-prog(parse-prog(lex(string-to-code-points(src))))\nend\nfun eb(n): emit-byte(n) end\neach(eb, compile-source(read-source()))\n`);
  return parts
    .join("\n")
    .split("\n")
    .filter((l) => !/^\s*provide\b/.test(l) && !/^\s*include\s+file/.test(l))
    .join("\n");
}

const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

// Which constructs does the compiler's own source use that the mini-language may
// not support yet? (a quick static checklist to guide the next implementation step)
function featureGaps(src: string): string[] {
  const checks: [string, RegExp][] = [
    ["# line comments", /(^|\n)\s*#/],
    ["data declarations", /\bdata\b/],
    ["cases expressions", /\bcases\(/],
    ["list literals [list: …]", /\[list:/],
    ["lambdas (lam)", /\blam\(/],
    ["tuples / .{n}", /\.\{|\{[^}]*;[^}]*\}/],
    ["string literals", /"/],
    ["string ops (string-to-code-points)", /string-to-code-points/],
    ["multi-arg builtins (map/foldl/append/reverse/length)", /\b(map|foldl|append|reverse|length|range)\b/],
  ];
  return checks.filter(([, re]) => re.test(src)).map(([n]) => n);
}

console.log("=== Self-hosting fixpoint check ===\n");
const A = await compileSelfHostCompiler();
console.log(`Stage A: seed -> compiler.wasm  (${A.length} bytes)`);

const src = await ownSource();
console.log(`Compiler's own source: ${src.length} bytes across ${MODULES.length} modules\n`);

let B: Uint8Array | null = null;
try {
  B = await compileWithModule(A, src);
  console.log(`Stage B: compiler.wasm compiled its own source -> compiler2.wasm (${B.length} bytes)`);
} catch (e) {
  console.log("Stage B: ❌ compiler.wasm CANNOT yet compile its own source.");
  console.log("   first failure:", String((e as Error).message ?? e));
  console.log("\nFIXPOINT: not reached. The self-hosted compiler must grow to support");
  console.log("the features its own source uses:");
  for (const g of featureGaps(src)) console.log("   - " + g);
  console.log("\n(A==B / B==C become checkable once Stage B succeeds.)");
  process.exit(0);
}

try {
  const C = await compileWithModule(B, src);
  console.log(`Stage C: compiler2.wasm compiled its own source -> compiler3.wasm (${C.length} bytes)\n`);
  console.log(eq(B, C) ? "FIXPOINT ✅  B == C (self-hosted compiler reproduces itself)"
                       : "FIXPOINT ❌  B != C (not yet stable)");
  console.log(eq(A, B) ? "Also: A == B (seed output is already a fixpoint)"
                       : "Note: A != B (seed and self-hosted codegen differ; B==C is the real fixpoint)");
} catch (e) {
  console.log("Stage C: ❌", String((e as Error).message ?? e));
}
