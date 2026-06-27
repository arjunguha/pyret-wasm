// End-to-end check of the self-hosted SURFACE PARSER (Option B in
// self-host/parser-plan.md): the seed's JS GLR parser produces a CST, the host
// (parse-bridge.ts) lowers it to a flat pre-order node stream, and the Pyret-side
// deserializer (self-host/parse-from-tree.arr, reached via parse-pyret.arr's
// `surface-parse`) rebuilds real ast.arr AST values from it — verified by running
// a seed-compiled program that calls surface-parse and inspects the result.

import { test, expect } from "bun:test";
import { resolve } from "path";
import { buildSourceFile } from "../src/build.ts";
import { parsePyret } from "../src/parser/pyret-parser.ts";
import { serializeCst, TAGS } from "../src/runtime/parse-bridge.ts";
import { buildHostImports, newHostState } from "../src/runtime/run.ts";

const FIXTURE = resolve(import.meta.dir, "fixtures/surface-parse.arr");
const DETAIL = resolve(import.meta.dir, "fixtures/surface-parse-detail.arr");
const INFO = resolve(import.meta.dir, "fixtures/surface-parse-info.arr");
const ANN = resolve(import.meta.dir, "fixtures/surface-parse-ann.arr");
const ANNLABEL = resolve(import.meta.dir, "fixtures/surface-parse-annlabel.arr");
const IMPFILE = resolve(import.meta.dir, "fixtures/surface-parse-impfile.arr");
const DATA = resolve(import.meta.dir, "fixtures/surface-parse-data.arr");
const WHERE = resolve(import.meta.dir, "fixtures/surface-parse-where.arr");
const MULTILET = resolve(import.meta.dir, "fixtures/surface-parse-multilet.arr");

// Run a seed-compiled fixture with the host bridge primed to parse `src`.
async function runWithSource(wasm: Uint8Array, src: string): Promise<string> {
  const state = newHostState();
  state.sourceBytes = new TextEncoder().encode(src);
  state.parseNodes = serializeCst(await parsePyret(src));
  const imports = buildHostImports(state);
  const { instance } = await WebAssembly.instantiate(wasm as BufferSource, imports);
  state.instance = instance;
  state.memory = instance.exports.memory as WebAssembly.Memory;
  (instance.exports.main as () => void)();
  return state.captured;
}

test("surface-parse: '5' -> s-program / s-block / s-num", async () => {
  const wasm = await buildSourceFile(FIXTURE);
  const out = await runWithSource(wasm, "5");
  expect(out).toContain("prog=true"); // is-s-program
  expect(out).toContain("blk=true"); // is-s-block
  expect(out).toContain("label=s-num"); // first statement ctor
});

// Each source's first statement should rebuild into the matching ast.arr ctor,
// exercising the full bridge (parse-bridge lowering + parse-from-tree rebuild).
const FORMS: Array<[string, string]> = [
  ["42", "s-num"],
  ['"hi"', "s-str"],
  ["true", "s-bool"],
  ["x", "s-id"],
  ["1 + 2", "s-op"],
  ["f(1)", "s-app"],
  ["o.x", "s-dot"],
  ["a.b(2)", "s-app"], // method call = app of a dot
  ["if x: 1 else: 2 end", "s-if-else"],
  ["if x: 1 end", "s-if"],
  ["x = 5", "s-let"],
  ["var y = 3", "s-var"],
  ["fun f(a): a end", "s-fun"],
  ["lam(a): a end", "s-lam"],
  ["[list: 1, 2]", "s-construct"],
  ["5 is 6", "s-check-test"],
  // round 2
  ["5 is-not 6", "s-check-test"],
  ["5 satisfies even", "s-check-test"],
  ['f() raises "x"', "s-check-test"],
  ["data D: | a(x) | b end", "s-data"],
  ["cases(List) l: | empty => 1 end", "s-cases"],
  ["cases(List) l: | empty => 1 | else => 2 end", "s-cases-else"],
  ["when x: 1 end", "s-when"],
  ["{1; 2; 3}", "s-tuple"],
  ["for each(x from l): x end", "s-for"],
  ["if x: 1 else if y: 2 else: 3 end", "s-if-else"],
  ["fun f(x :: Number): x end", "s-fun"],
  // round 3
  ["1/2", "s-frac"],
  ["ask: | x then: 1 | otherwise: 2 end", "s-if-pipe-else"],
  ["ask: | x then: 1 end", "s-if-pipe"],
  ["data D: | a(ref x) end", "s-data"],
  ["data D: | a(x) with: method m(self): 1 end end", "s-data"],
  ["data D: | a(x) sharing: method s(self): 1 end end", "s-data"],
  // round 4
  ["block: 1 end", "s-user-block"],
  ["...", "s-template"],
  ["(5)", "s-paren"],
  ["spy: x end", "s-spy-block"],
  ['spy "m": y: 2 end', "s-spy-block"],
  // round 5 (corpus blockers)
  ["check: 5 is 5 end", "s-check"],
  ['check "n": 5 is 5 end', "s-check"],
  ["examples: 5 is 5 end", "s-check"],
  ["type N = Number", "s-type"],
  ["x := 5", "s-assign"],
  ["f<Number>", "s-instantiate"], // bare instantiation (no call)
  ["o!{a: 1}", "s-update"],
  ["table: a, b\n  row: 1, 2\nend", "s-table"],
  // round 6 (corpus blockers cont.)
  ["o.{a: 1}", "s-extend"],
  ["o!f", "s-get-bang"],
  ["t.{0}", "s-tuple-get"],
  ["rec x = 1", "s-rec"],
  ["method(self): self end", "s-method"],
  ["letrec x = 1: x end", "s-letrec"],
  ["~1/2", "s-rfrac"],
  ["5 is%(within(2)) 6", "s-check-test"], // is%(pred) refinement clause
  // round 7 (multi-binding let + reactor)
  // NB: s-let-expr.label() is "s-let" in ast.arr; the dedicated test below asserts
  // the s-let-expr identity + bind kinds to distinguish it from a single s-let.
  ["let a = 1, b = 2: a + b end", "s-let"],
  ["reactor: init: 1, on-tick: f end", "s-reactor"],
];

test("surface-parse: rebuilds the right ast.arr ctor for each core form", async () => {
  const wasm = await buildSourceFile(FIXTURE);
  for (const [src, label] of FORMS) {
    const out = await runWithSource(wasm, src);
    expect(out).toContain("prog=true");
    expect(out, `source ${JSON.stringify(src)}`).toContain(`label=${label}`);
  }
});

test("surface-parse: rebuilt AST carries real payloads (5 + x)", async () => {
  const wasm = await buildSourceFile(DETAIL);
  const out = await runWithSource(wasm, "5 + x");
  expect(out).toContain("label=s-op");
  expect(out).toContain("op=op+");
  expect(out).toContain("left=s-num");
  expect(out).toContain("ln=5");
  expect(out).toContain("right=s-id");
  expect(out).toContain("rid=x");
});

// The CST -> flat-AST lowering itself, exercised directly (no WASM). PROGRAM now
// always carries an IMPORTS helper child (empty here) before the BLOCK.
test("serializeCst lowers core forms to a flat pre-order stream", async () => {
  // "5" -> program, imports, block, num
  const five = serializeCst(await parsePyret("5"));
  expect(five.map((n) => n.tag)).toEqual([TAGS.PROGRAM, TAGS.IMPORTS, TAGS.BLOCK, TAGS.NUM]);
  expect(five[3]!.str).toBe("5");

  // "1 + 2" -> program, imports, block, op(+, num, num)
  const sum = serializeCst(await parsePyret("1 + 2"));
  expect(sum.map((n) => n.tag)).toEqual([
    TAGS.PROGRAM, TAGS.IMPORTS, TAGS.BLOCK, TAGS.OP, TAGS.NUM, TAGS.NUM,
  ]);
  expect(sum[3]!.str).toBe("op+");

  // string / bool / id leaves
  expect(serializeCst(await parsePyret('"hi"'))[3]!.str).toBe("hi");
  expect(serializeCst(await parsePyret("true"))[3]!.str).toBe("true");
  expect(serializeCst(await parsePyret("x"))[3]!.str).toBe("x");

  // app: APP -> [ID, EXPRS -> [NUM]]
  const app = serializeCst(await parsePyret("f(1)"));
  expect(app.map((n) => n.tag)).toEqual([
    TAGS.PROGRAM, TAGS.IMPORTS, TAGS.BLOCK, TAGS.APP, TAGS.ID, TAGS.EXPRS, TAGS.NUM,
  ]);

  // fun: FUN -> [BINDS -> [BIND], BLOCK -> [ID]]
  const fun = serializeCst(await parsePyret("fun f(a): a end"));
  expect(fun.map((n) => n.tag)).toEqual([
    TAGS.PROGRAM, TAGS.IMPORTS, TAGS.BLOCK,
    TAGS.FUN, TAGS.BINDS, TAGS.BIND, TAGS.BLOCK, TAGS.ID,
  ]);
});

// Prelude lowering: `provide *` + import/include populate the program header.
test("surface-parse: provide / import / include populate the program header", async () => {
  const wasm = await buildSourceFile(INFO);
  const out = await runWithSource(wasm, 'provide *\nimport lists as L\ninclude string-dict\n5');
  expect(out).toContain("provide=s-provide-all");
  expect(out).toContain("nimports=2");
  expect(out).toContain("imp0=s-import"); // first prelude entry is the `import`
  expect(out).toContain("label=s-num"); // block still holds the trailing expr
});

// Multi-statement blocks keep every statement (not just the first).
test("surface-parse: multi-statement block keeps all statements", async () => {
  const wasm = await buildSourceFile(INFO);
  const out = await runWithSource(wasm, "1\n2\n3");
  expect(out).toContain("nstmts=3");
  expect(out).toContain("provide=s-provide-none");
  expect(out).toContain("nimports=0");
});

// Typed bindings rebuild an a-name annotation on the bind.
test("surface-parse: typed fun param carries an a-name annotation", async () => {
  const wasm = await buildSourceFile(ANN);
  const out = await runWithSource(wasm, "fun f(x :: Number): x end");
  expect(out).toContain("argname=x");
  expect(out).toContain("annlabel=a-name");
  expect(out).toContain("anntype=Number");
});

// Richer annotation forms rebuild the matching ast.arr Ann ctor.
const ANN_FORMS: Array<[string, string]> = [
  ["fun f(g :: (Number -> String)): g end", "a-arrow"],
  ["fun f(l :: List<Number>): l end", "a-app"],
  ["fun f(x :: a.B): x end", "a-dot"],
  ["fun f(p :: {Number; String}): p end", "a-tuple"],
  ["fun f(r :: {a :: Number, b :: String}): r end", "a-record"],
  ["fun f(x :: Number%(is-positive)): x end", "a-pred"],
];

test("surface-parse: arrow/app/dot/tuple annotations rebuild the right Ann ctor", async () => {
  const wasm = await buildSourceFile(ANNLABEL);
  for (const [src, label] of ANN_FORMS) {
    const out = await runWithSource(wasm, src);
    expect(out, `source ${JSON.stringify(src)}`).toContain(`annlabel=${label}`);
  }
});

// `import file("...") as F` rebuilds an s-special-import with kind + args.
test("surface-parse: import file(...) rebuilds s-special-import", async () => {
  const wasm = await buildSourceFile(IMPFILE);
  const out = await runWithSource(wasm, 'import file("foo.arr") as F\n5');
  expect(out).toContain("implabel=s-import");
  expect(out).toContain("filelabel=s-special-import");
  expect(out).toContain("kind=file");
  expect(out).toContain("arg0=foo.arr");
  expect(out).toContain("alias=F");
});

// `provide { ... }` rebuilds an s-provide (record form) on the program header.
test("surface-parse: provide { ... } rebuilds s-provide", async () => {
  const wasm = await buildSourceFile(INFO);
  const out = await runWithSource(wasm, "provide { x: 1 } end\n5");
  expect(out).toContain("provide=s-provide");
  expect(out).toContain("label=s-num");
});

// data: a `ref` member is s-mutable; `with:`/`sharing:` methods are s-method-field.
test("surface-parse: data ref member + with/sharing methods", async () => {
  const wasm = await buildSourceFile(DATA);
  const src = "data D: | a(ref x) with: method m(self): 1 end sharing: method s(self): 2 end end";
  const out = await runWithSource(wasm, src);
  expect(out).toContain("mtype=s-mutable");
  expect(out).toContain("nwith=1");
  expect(out).toContain("wmlabel=s-method-field");
  expect(out).toContain("nshared=1");
  expect(out).toContain("shlabel=s-method-field");
});

// round 4: a `where:` clause populates `_check` on s-fun / s-data.
test("surface-parse: where-clause populates _check", async () => {
  const wasm = await buildSourceFile(WHERE);
  const fun = await runWithSource(wasm, "fun f(x): x where: f(1) is 1 end");
  expect(fun).toContain("label=s-fun");
  expect(fun).toContain("haschk=true");
  expect(fun).toContain("chklabel=s-block");
  const data = await runWithSource(wasm, "data D: | a where: 1 is 1 end");
  expect(data).toContain("label=s-data");
  expect(data).toContain("haschk=true");
});

// round 4: `include file("...")` rebuilds an s-include of s-special-import.
test("surface-parse: include file(...) rebuilds s-include", async () => {
  const wasm = await buildSourceFile(INFO);
  const out = await runWithSource(wasm, 'include file("foo.arr")\n5');
  expect(out).toContain("nimports=1");
  expect(out).toContain("imp0=s-include");
  expect(out).toContain("label=s-num");
});

// round 4: `provide: a, b end` (provide-block spec form) rebuilds s-provide-block.
// round 4: `provide: a, b end` (provide-block spec form) — the pure-Pyret parser now builds
// s-provide-block (placed in s-program's _provide slot, matching the JS-GLR bridge).
test("surface-parse: provide-block (provide: ... end) rebuilds s-provide-block", async () => {
  const wasm = await buildSourceFile(INFO);
  const out = await runWithSource(wasm, "provide: x, y end\n5");
  expect(out).toContain("provide=s-provide-block");
  expect(out).toContain("label=s-num");
});

// round 7: multi-binding `let a = 1, var b = 2: ... end` rebuilds s-let-expr with a
// mix of s-let-bind / s-var-bind (label() is "s-let", so assert the variant identity).
test("surface-parse: multi-binding let rebuilds s-let-expr with let/var binds", async () => {
  const wasm = await buildSourceFile(MULTILET);
  const out = await runWithSource(wasm, "let a = 1, var b = 2: a end");
  expect(out).toContain("is-let-expr=true");
  expect(out).toContain("nbinds=2");
  expect(out).toContain("b0-let=true");
  expect(out).toContain("b1-var=true");
});
