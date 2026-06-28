#!/usr/bin/env bun
// Report stats on the merged whole-compiler source used by the fixpoint byte-compare
// (the prelude + every compile-driver closure module body, as one Pyret program).
// usage: bun scripts/gen-merged-compiler.ts
import { mergeSourcesFor } from "../src/build.ts";
import { resolve } from "path";
const DRIVER = resolve(import.meta.dir, "../self-host/compile-driver.arr");
const { source, paths } = await mergeSourcesFor(DRIVER);
console.log(`merged modules : ${paths.length}`);
console.log(`merged source  : ${source.length} chars, ${source.split("\n").length} lines`);
