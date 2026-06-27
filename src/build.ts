// Node entry: build Pyret source (with prelude) to a WASM binary.
import { parsePyret } from "./parser/pyret-parser.ts";
import { buildSourceWith } from "./build-core.ts";
import { compile } from "./compiler/compile.ts";
import { PRELUDE_SRC } from "./compiler/prelude.ts";
import type { CstNode } from "./parser/parse-core.ts";
import { dirname, resolve } from "path";
import { existsSync } from "fs";

export async function buildSource(src: string): Promise<Uint8Array> {
  return buildSourceWith(parsePyret, src);
}

// ---- multi-module loading ----
// `import file("…")` / `include file("…")`  AND  trove-name imports
// (`import pprint as PP`, `include lists`) resolved to .arr files in our copied
// front-end tree (self-compiler/), for self-hosting. Whole-program: each loaded
// module's top-level names join the single global namespace; `N.member` (module
// alias) and bare names from `include`/`provide *` resolve to those globals.

const SELF_COMPILER = resolve(import.meta.dir, "../self-compiler");
// Modules our prelude/runtime already provide, or builtins with no .arr — treated
// as already-global (NOT loaded). Everything else with a matching .arr is compiled.
const SKIP_MODULES = new Set([
  "global", "base", "lists", "option", "either",
  "arrays", "sets", "string-dict", "s-exp", "s-exp-structs", "ffi",
  "contracts", "checker", "tables", "table", "render-error-display",
]);

function findDescendant(node: CstNode, name: string): CstNode | undefined {
  if (node.name === name) return node;
  for (const k of node.kids) {
    const r = findDescendant(k, name);
    if (r) return r;
  }
  return undefined;
}

function stripStr(v: string): string {
  if (v.startsWith("```") && v.endsWith("```")) return v.slice(3, -3);
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'")) return v.slice(1, -1);
  return v;
}

// Absolute paths of local modules a program depends on (file imports + trove-name
// imports/includes resolved against `dir`, self-compiler/trove, self-compiler/compiler).
// Returns only paths that exist; unknown/core modules are skipped (already global).
function localImports(program: CstNode, dir: string): string[] {
  const prelude = program.kids.find((k) => k.name === "prelude");
  if (!prelude) return [];
  const out: string[] = [];
  for (const stmt of prelude.kids) {
    if (stmt.name !== "import-stmt") continue;
    const special = findDescendant(stmt, "import-special");
    if (special) {
      const nm = special.kids.find((k) => k.name === "NAME");
      const str = special.kids.find((k) => k.name === "STRING");
      if (nm?.value === "file" && str?.value) {
        const rel = stripStr(str.value);
        out.push(resolve(dir, rel.endsWith(".arr") ? rel : rel + ".arr"));
      }
      continue;
    }
    // bare module import/include: `import NAME as A` | `include NAME`
    const impName = findDescendant(stmt, "import-name");
    const nm = impName?.kids.find((k) => k.name === "NAME");
    if (nm?.value && !SKIP_MODULES.has(nm.value)) {
      for (const cand of [
        resolve(dir, nm.value + ".arr"),
        resolve(SELF_COMPILER, "trove", nm.value + ".arr"),
        resolve(SELF_COMPILER, "compiler", nm.value + ".arr"),
      ]) {
        if (existsSync(cand)) { out.push(cand); break; }
      }
    }
  }
  return out;
}

// Merge many programs into one: concatenated preludes (imports/provides) and
// concatenated blocks (definitions). Whole-program compilation by inlining.
function mergeMany(programs: CstNode[]): CstNode {
  const preludeKids: CstNode[] = [];
  const blockKids: CstNode[] = [];
  for (const p of programs) {
    const pl = p.kids.find((k) => k.name === "prelude");
    const bl = p.kids.find((k) => k.name === "block");
    if (pl) preludeKids.push(...pl.kids);
    if (bl) blockKids.push(...bl.kids);
  }
  const pos = programs[programs.length - 1]!.pos;
  return {
    name: "program",
    pos,
    kids: [
      { name: "prelude", kids: preludeKids, pos },
      { name: "block", kids: blockKids, pos },
    ],
  };
}

let _preludeProgram: CstNode | null = null;

async function loadModule(
  absPath: string,
  seen: Map<string, CstNode | null>,
  order: CstNode[],
): Promise<void> {
  if (seen.has(absPath)) return; // already loaded (or in progress -> break cycles)
  seen.set(absPath, null);
  const src = await Bun.file(absPath).text();
  const program = await parsePyret(src);
  const dir = dirname(absPath);
  for (const dep of localImports(program, dir)) {
    await loadModule(dep, seen, order);
  }
  order.push(program); // post-order: dependencies precede dependents
  seen.set(absPath, program);
}

// Build a .arr file, recursively inlining its local-file imports.
export async function buildSourceFile(path: string): Promise<Uint8Array> {
  const seen = new Map<string, CstNode | null>();
  const order: CstNode[] = [];
  await loadModule(resolve(path), seen, order);
  if (!_preludeProgram) _preludeProgram = await parsePyret(PRELUDE_SRC);
  return compile(mergeMany([_preludeProgram, ...order]));
}
