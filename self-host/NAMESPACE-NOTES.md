# Cross-module namespace collisions in the seed (analysis + status)

## The problem

The seed compiles a whole program by **flattening** every imported module's top-level
block into ONE global namespace (`mergeMany` / `loadModule` in `src/build.ts`). Two
modules can then define the SAME top-level name. Examples that actually bit us:

- `encoder.arr`'s `fun concat` vs `pprint.arr`'s `data ... | concat(...)` variant
  constructor → `Out of bounds array.get` when both were co-imported (hand-renamed to
  `concat-bytes` as a stop-gap).
- The desugar/well-formed/resolve-scope module-init hang (a cross-module `shadow map`
  cycle) — fixed earlier by **program-order name resolution** for globals.

As the merged module set grows toward the full self-hosted compiler (~30 modules), every
duplicate top-level name is a latent OOB/null-ref.

## What this change adds (safe, shipped)

1. **Module-aware qualified access (`N.member`).** `src/build.ts` now records, per
   importing module, which module each `import X as N` alias names, and tags every
   top-level statement with its source module id (via a `WeakMap` — `mergeMany`/
   `stripChecks` preserve stmt-node identity, so no CstNode type change is needed).
   `src/compiler/compile.ts` records the defining module of every top-level global
   (`globalGens[].mod`) and variant (`variantGens`), and resolves `N.member` to the
   binding from the module `N` actually names (`resolveModuleMember` / `globalForMod` /
   `variantForMod` / `moduleTargetFor`). So a `fun foo` in one module and a `data`
   variant `foo` in another are BOTH reachable, each through its own alias.
   - Fallback is the previous first/last-wins behavior whenever module info is absent
     (single-string builds) or the alias's target module doesn't define the member
     (e.g. re-exports), so existing behavior is unchanged. Full suite stays green.

2. **A collision detector.** `detectCollisions` / the exported `collisionsFor(path)`
   report cross-module top-level name duplicates (funs, lets/vars, data type +
   constructor names). Logged to stderr when `PYRET_DEBUG_COLLISIONS` is set — turning
   silent OOBs into an actionable list. Used by `test/module-collision.test.ts`.

## UPDATE — module-scoped bare VARIANT references (shipped)

Bare references to a colliding **variant** name are now MODULE-SCOPED. `compile.ts`
`variantFor(name)` resolves a bare variant reference inside module M to M's OWN variant
of that name (via `variantGens` + referrer module = `orderToMod[resolveOrder]`), falling
back to last-wins only when M doesn't define it. The constructor/predicate fn caches
(`ctorFns`/`predFns`) are now keyed by variant **id** (globally unique) so two modules'
same-named variants get distinct wrappers. Applied at: `resolveName` (bare value/ctor +
bare `is-<v>`), the construction fast-path + bare `is-<v>` call, and `cases` branch
dispatch. This fixes the real `a-app`-defined-in-both-ast.arr-and-ast-anf.arr collision
(each module's bare refs use its own variant id → correct construction/cases/predicate).
Verified: `ast + ast-anf` co-import is clean, the whole front-end still loads, the new
`test/module-scope.test.ts` distinguishes (was a spurious "cases: no branch matched"),
and self-compile coverage went 15→19 modules. NOTE: this did NOT move the dominant
remaining blocker (×35 "null-ref at module load") — that is a separate backend-codegen
bug, not a namespace collision. Bare GLOBAL/fun references are still program-order
resolved (that already approximates module scoping, and the desugar-hang `shadow map`
fix depends on it) — see below.

## What is deliberately NOT changed (the hard part)

**Bare** (unqualified) references to a colliding **global/fun** name are still resolved by
program order + arity, NOT made module-aware. Reason: the flat namespace has no per-reference
module scope, and the real front-end *relies* on the existing arity rule selecting the
variant for bare constructor calls (e.g. pprint's methods call the 4-arg `concat`
variant while a same-module 2-arg `shadow concat` exists). An attempt to make a
later cross-module `fun` shadow an earlier-module variant for bare names
(`fnShadowsVariant`) regressed the front-end load (desugar/well-formed/resolve-scope),
because it diverted legitimate variant constructions — confirming bare cross-module
collisions are not safely decidable in the flat model. Qualified `N.member` is the exact
disambiguator and is what real Pyret code uses across modules anyway.

## The complete fix (future work)

To make even bare references collision-proof, give the seed a real per-module namespace
instead of flattening — either:

- **Alpha-rename** each non-entry module's top-level bindings to globally unique names
  (and rewrite that module's own references + importers' `N.member`), via a scope-aware
  CST pass. Correctness hinges on tracking local shadowing across the full grammar.
- Or **per-module compilation + linking** (compile each module to its own indices,
  link with an export/import table) — the "proper" module system. Larger change.

Both are substantial; the module-aware qualified access here covers the cases that
actually arise (modules are accessed through aliases) and removes the destructive
co-import failures, without the regression risk of a full rename/relink.
