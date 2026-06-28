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
// Original Pyret front-end (via the gitignored `pyret` symlink → ../pyret), used as a
// fallback for compiler sources we don't keep a self-compiler copy of (e.g. locators/*).
const PYRET_SRC_ARR = resolve(import.meta.dir, "../pyret/lang/src/arr");

// Pyret's own corpus tests import the real compiler via relative paths like
// `import file("../../../src/arr/compiler/compile-structs.arr")`. In our repo layout
// that resolves to a nonexistent `<repo>/src/arr/...`; the equivalent sources live in
// `self-compiler/{compiler,trove}/` (our modifiable copies) or `pyret/lang/src/arr/`
// (the originals). Redirect a `.../src/arr/<rest>` file import that doesn't exist to the
// self-compiler copy, else the original — so multi-file compiler tests resolve.
export function redirectFileImport(absPath: string): string {
  if (existsSync(absPath)) return absPath;
  const m = absPath.match(/[\\/]src[\\/]arr[\\/](.+\.arr)$/);
  if (m) {
    const rest = m[1]!;
    const inSelf = resolve(SELF_COMPILER, rest);
    if (existsSync(inSelf)) return inSelf;
    const inOrig = resolve(PYRET_SRC_ARR, rest);
    if (existsSync(inOrig)) { if (process.env?.PYRET_DEBUG_RESOLVE) console.error(`[resolve-fallback] ${rest} -> pyret/lang`); return inOrig; }
  }
  // A self-compiler source importing a sibling we don't keep a copy of (e.g.
  // `locators/*`) — fall back to the original tree so the closure resolves.
  const s = absPath.match(/[\\/]self-compiler[\\/](.+\.arr)$/);
  if (s) {
    const inOrig = resolve(PYRET_SRC_ARR, s[1]!);
    if (existsSync(inOrig)) { if (process.env?.PYRET_DEBUG_RESOLVE) console.error(`[resolve-fallback] ${s[1]} -> pyret/lang`); return inOrig; }
  }
  return absPath; // unchanged → surfaces the real ENOENT if it's a genuine miss
}

// Resolve an `import/include file("rel")` spec (relative to `dir`) to an absolute path,
// applying the src/arr redirect.
function resolveFileImport(dir: string, rel: string): string {
  return redirectFileImport(resolve(dir, rel.endsWith(".arr") ? rel : rel + ".arr"));
}
// Modules our prelude/runtime already provide, or builtins with no .arr — treated
// as already-global (NOT loaded). Everything else with a matching .arr is compiled.
const SKIP_MODULES = new Set([
  "global", "base", "lists", "option", "either",
  "arrays", "sets", "string-dict", "s-exp", "s-exp-structs", "ffi",
  "contracts", "checker", "tables", "table", "render-error-display",
]);
// NB: `either` is skipped — Either/left/right are prelude-provided so the prelude's
// fold-while can use them; equality/error are NOT skipped (loaded as real modules).

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

// Resolve a bare module name (`import NAME as A` / `include NAME`) to an existing
// .arr path in our front-end tree, or undefined for core/prelude-provided modules.
function resolveModulePath(name: string, dir: string): string | undefined {
  if (SKIP_MODULES.has(name)) return undefined;
  for (const cand of [
    resolve(dir, name + ".arr"),
    resolve(SELF_COMPILER, "trove", name + ".arr"),
    resolve(SELF_COMPILER, "compiler", name + ".arr"),
  ]) {
    if (existsSync(cand)) return cand;
  }
  return undefined;
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
        out.push(resolveFileImport(dir, stripStr(str.value)));
      }
      continue;
    }
    // bare module import/include: `import NAME as A` | `include NAME`
    const impName = findDescendant(stmt, "import-name");
    const nm = impName?.kids.find((k) => k.name === "NAME");
    const p = nm?.value ? resolveModulePath(nm.value, dir) : undefined;
    if (p) out.push(p);
  }
  return out;
}

// The module ALIASES a program introduces with `import <src> as N`, paired with the
// absolute path the alias points to (when it's a local module we actually load).
// Used to make `N.member` access MODULE-AWARE under whole-program flattening — so two
// modules exporting the same name (e.g. a `fun foo` vs a `data` variant `foo`) are
// each reachable through their own alias rather than colliding in the flat namespace.
function moduleAliasTargets(program: CstNode, dir: string): { alias: string; path: string }[] {
  const prelude = program.kids.find((k) => k.name === "prelude");
  if (!prelude) return [];
  const out: { alias: string; path: string }[] = [];
  for (const stmt of prelude.kids) {
    if (stmt.name !== "import-stmt") continue;
    const asTok = stmt.kids.find((k) => k.name === "AS");
    if (!asTok) continue; // only `import ... as N` makes an alias
    const aliasNode = stmt.kids[stmt.kids.length - 1];
    const alias = aliasNode?.name === "NAME" ? aliasNode.value : undefined;
    if (!alias || alias === "_") continue;
    const special = findDescendant(stmt, "import-special");
    if (special) {
      const nm = special.kids.find((k) => k.name === "NAME");
      const str = special.kids.find((k) => k.name === "STRING");
      if (nm?.value === "file" && str?.value) {
        out.push({ alias, path: resolveFileImport(dir, stripStr(str.value)) });
      }
      continue;
    }
    const impName = findDescendant(stmt, "import-name");
    const nm = impName?.kids.find((k) => k.name === "NAME");
    const p = nm?.value ? resolveModulePath(nm.value, dir) : undefined;
    if (p) out.push({ alias, path: p });
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

// Remove top-level `check:`/`where:`-style test statements from a module. In real
// Pyret, importing a module does NOT run its test blocks (they run only when the
// module is the entry point under a test runner). Our whole-program flattening would
// otherwise execute every imported module's tests at load — and any failing/crashing
// test (e.g. type-structs' `check:` exercising the type pretty-printer) aborts the
// whole program. So strip checks from every module except the entry point.
function stripChecks(program: CstNode): CstNode {
  const block = program.kids.find((k) => k.name === "block");
  if (!block) return program;
  const kept = block.kids.filter((stmt) => {
    if (stmt.name !== "stmt") return true;
    const inner = stmt.kids[0];
    if (!inner) return true;
    if (inner.name === "check-expr") return false;
    // `x is y` / `x raises ...` are check-tests with >1 child; a single-child
    // check-test is just a bare expression (keep it).
    if (inner.name === "check-test" && inner.kids.length > 1) return false;
    return true;
  });
  return {
    name: "program",
    pos: program.pos,
    kids: program.kids.map((k) => (k === block ? { ...block, kids: kept } : k)),
  };
}

let _preludeProgram: CstNode | null = null;

async function loadModule(
  absPath: string,
  seen: Map<string, CstNode | null>,
  order: CstNode[],
  orderPaths: string[],
): Promise<void> {
  if (seen.has(absPath)) return; // already loaded (or in progress -> break cycles)
  seen.set(absPath, null);
  const src = await Bun.file(absPath).text();
  const program = await parsePyret(src);
  const dir = dirname(absPath);
  for (const dep of localImports(program, dir)) {
    await loadModule(dep, seen, order, orderPaths);
  }
  order.push(program); // post-order: dependencies precede dependents
  orderPaths.push(absPath);
  seen.set(absPath, program);
}

const PRELUDE_PATH = "<prelude>";

// Stmt nodes of `program` (top-level block statements). mergeMany/stripChecks
// preserve stmt-node IDENTITY, so a WeakMap keyed by these nodes survives the merge —
// letting the compiler recover which MODULE each top-level statement came from.
function topStmts(program: CstNode): CstNode[] {
  const block = program.kids.find((k) => k.name === "block");
  return block ? block.kids.filter((s) => s.name === "stmt") : [];
}

// Detect cross-module collisions: a top-level binding NAME (fun / let / var / data
// type / variant constructor) defined in more than one module. Under flat-namespace
// merging these silently alias (last-wins for variants, program-order for globals),
// a latent source of OOB/null-ref. Returned for diagnostics; logged when
// PYRET_DEBUG_COLLISIONS is set.
function topLevelNames(program: CstNode): string[] {
  const out: string[] = [];
  for (const stmt of topStmts(program)) {
    const inner = stmt.kids[0];
    if (!inner) continue;
    if (inner.name === "fun-expr") {
      const nm = inner.kids.find((k) => k.name === "NAME");
      if (nm?.value) out.push(nm.value);
    } else if (inner.name === "let-expr" || inner.name === "var-expr" || inner.name === "rec-expr") {
      const b = findDescendant(inner, "NAME");
      if (b?.value) out.push(b.value);
    } else if (inner.name === "data-expr") {
      const tn = inner.kids.find((k) => k.name === "NAME");
      if (tn?.value) out.push(tn.value);
      for (const kid of inner.kids) {
        if (kid.name !== "first-data-variant" && kid.name !== "data-variant") continue;
        const ctor = kid.kids.find((k) => k.name === "variant-constructor");
        const vn = ctor ? ctor.kids.find((k) => k.name === "NAME") : kid.kids.find((k) => k.name === "NAME");
        if (vn?.value) out.push(vn.value);
      }
    }
  }
  return out;
}

function detectCollisions(modules: { path: string; program: CstNode }[]): Map<string, string[]> {
  const byName = new Map<string, string[]>();
  for (const { path, program } of modules) {
    for (const nm of new Set(topLevelNames(program))) {
      const arr = byName.get(nm) ?? [];
      arr.push(path);
      byName.set(nm, arr);
    }
  }
  const collisions = new Map<string, string[]>();
  for (const [nm, paths] of byName) if (paths.length > 1) collisions.set(nm, paths);
  return collisions;
}

// Build a .arr file, recursively inlining its local-file imports.
export async function buildSourceFile(path: string): Promise<Uint8Array> {
  const seen = new Map<string, CstNode | null>();
  const order: CstNode[] = [];
  const orderPaths: string[] = [];
  await loadModule(resolve(path), seen, order, orderPaths);
  if (!_preludeProgram) _preludeProgram = await parsePyret(PRELUDE_SRC);
  // The entry module (loaded last, post-order) keeps its check blocks; all imported
  // modules (and the prelude) have theirs stripped — imports don't run tests.
  const main = order[order.length - 1]!;
  const imports = order.slice(0, -1).map(stripChecks);
  const prelude = stripChecks(_preludeProgram);
  // The merged module list, in compile order. Index = MODULE id.
  const programs = [prelude, ...imports, main];
  const programPaths = [PRELUDE_PATH, ...orderPaths.slice(0, -1), orderPaths[orderPaths.length - 1] ?? resolve(path)];
  const pathToMod = new Map<string, number>();
  programPaths.forEach((p, i) => pathToMod.set(p, i));

  // Tag every top-level stmt with its module id (survives the merge via identity).
  const stmtMod = new WeakMap<CstNode, number>();
  programs.forEach((prog, modIdx) => {
    for (const stmt of topStmts(prog)) stmtMod.set(stmt, modIdx);
  });

  // Per-module alias table: importerMod -> (alias -> targetMod). Lets `N.member`
  // resolve to the SPECIFIC module N names, instead of a flat first/last-wins guess.
  const aliasMap = new Map<number, Map<string, number>>();
  programs.forEach((prog, modIdx) => {
    const p = programPaths[modIdx]!;
    const dir = p === PRELUDE_PATH ? resolve(path, "..") : dirname(p);
    const tbl = new Map<string, number>();
    for (const { alias, path: tgt } of moduleAliasTargets(prog, dir)) {
      const tm = pathToMod.get(tgt);
      if (tm !== undefined) tbl.set(alias, tm);
    }
    if (tbl.size > 0) aliasMap.set(modIdx, tbl);
  });

  if (process.env?.PYRET_DEBUG_COLLISIONS) {
    const cols = detectCollisions(programs.map((program, i) => ({ path: programPaths[i]!, program })));
    if (cols.size > 0) {
      console.error(`[collision] ${cols.size} cross-module top-level name collision(s):`);
      for (const [nm, paths] of cols) console.error(`  ${nm}: ${paths.map((p) => p.replace(/.*\//, "")).join(", ")}`);
    }
  }

  return compile(mergeMany(programs), { stmtMod, aliasMap });
}

// ---- merge-to-SOURCE (for the self-hosting fixpoint) ----
// The self-hosted compiler driver compiles a SINGLE program (its surface-parse parses one
// program, no import/module merge). To feed it the WHOLE compiler, produce one merged SOURCE
// text: the prelude + every closure module's BODY (sliced after its prelude via the CST block's
// startChar), in dependency order. NOTE: this is a flat concat — qualified `N.member` refs and
// cross-module name collisions are NOT resolved here (the seed does that on CstNodes via
// aliasMap/stmtMod). So the merged source only round-trips through a compiler that either does
// module loading or qualified-ref flattening. Returns { source, paths } for diagnostics.
export async function mergeSourcesFor(path: string): Promise<{ source: string; paths: string[] }> {
  const seen = new Map<string, CstNode | null>();
  const order: CstNode[] = [];
  const orderPaths: string[] = [];
  await loadModule(resolve(path), seen, order, orderPaths);
  if (!_preludeProgram) _preludeProgram = await parsePyret(PRELUDE_SRC);
  const parts: string[] = [PRELUDE_SRC];
  for (let i = 0; i < order.length; i++) {
    const prog = order[i]!;
    const src = await Bun.file(orderPaths[i]!).text();
    const block = prog.kids.find((k) => k.name === "block");
    const start = (block?.pos?.startChar && block.pos.startChar > 0) ? block.pos.startChar : 0;
    parts.push(`\n# ===== module: ${orderPaths[i]} =====\n`);
    parts.push(src.slice(start));
  }
  return { source: parts.join("\n"), paths: [PRELUDE_PATH, ...orderPaths] };
}

// Exposed for tests: the cross-module top-level name collisions for a .arr entry.
export async function collisionsFor(path: string): Promise<Map<string, string[]>> {
  const seen = new Map<string, CstNode | null>();
  const order: CstNode[] = [];
  const orderPaths: string[] = [];
  await loadModule(resolve(path), seen, order, orderPaths);
  if (!_preludeProgram) _preludeProgram = await parsePyret(PRELUDE_SRC);
  const main = order[order.length - 1]!;
  const imports = order.slice(0, -1).map(stripChecks);
  const programs = [stripChecks(_preludeProgram), ...imports, main];
  const programPaths = [PRELUDE_PATH, ...orderPaths.slice(0, -1), orderPaths[orderPaths.length - 1] ?? resolve(path)];
  return detectCollisions(programs.map((program, i) => ({ path: programPaths[i]!, program })));
}
