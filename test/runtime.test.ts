import { test, expect } from "bun:test";
import binaryen from "binaryen";
import { buildTypes } from "../src/compiler/types.ts";
import { Runtime, SCRATCH_OFFSET } from "../src/compiler/runtime.ts";

// Build a module containing the runtime plus small exported test wrappers,
// instantiate it, and exercise the number tower.
async function instantiate() {
  const m = new binaryen.Module();
  m.setFeatures(binaryen.Features.All & ~(1 << 21));
  const t = buildTypes();
  m.setMemory(1, 256, "memory");
  new Runtime(m, t).build();

  const L = binaryen.i64;
  const fx = (i: number) => m.call("$make_fix", [m.local.get(i, L)], t.FixnumRef);
  const rat = () => [m.call("$make_rat", [fx(0), fx(1)], t.NumRef), m.call("$make_rat", [fx(2), fx(3)], t.NumRef)] as const;
  // add_test(an, ad, bn, bd) -> i32 length; writes decimal of (an/ad)+(bn/bd)
  const [a, b] = rat();
  m.addFunction("add_test", binaryen.createType([L, L, L, L]), binaryen.i32, [],
    m.call("$num_to_string", [m.call("$num_add", [a, b], t.NumRef)], binaryen.i32));
  m.addFunctionExport("add_test", "add_test");

  const [a2, b2] = rat();
  m.addFunction("mul_test", binaryen.createType([L, L, L, L]), binaryen.i32, [],
    m.call("$num_to_string", [m.call("$num_mul", [a2, b2], t.NumRef)], binaryen.i32));
  m.addFunctionExport("mul_test", "mul_test");

  const [a3, b3] = rat();
  m.addFunction("div_test", binaryen.createType([L, L, L, L]), binaryen.i32, [],
    m.call("$num_to_string", [m.call("$num_divide", [a3, b3], t.NumRef)], binaryen.i32));
  m.addFunctionExport("div_test", "div_test");

  if (!m.validate()) throw new Error("module did not validate");
  const bin = m.emitBinary();
  const noop = () => {};
  const { instance } = await WebAssembly.instantiate(bin, {
    host: {
      print: noop, check_stash: noop, check_fail: noop, check_summary: noop,
      check_fail_isnot: noop, check_fail_pred: noop,
      raise: (p: number, l: number) => { throw new Error("raise"); },
      check_raises: () => 0,
      emit_byte: () => {},
      do_pause: () => { throw new Error("pause"); },
      read_source_into: () => 0,
      parse_source: () => 0, parse_node_tag: () => 0,
      parse_node_nkids: () => 0, parse_node_str_into: () => 0,
      math1: () => 0, math2: () => 0,
    },
  });
  return instance.exports as any;
}

function readScratch(ex: any, len: number): string {
  const mem = new Uint8Array((ex.memory as WebAssembly.Memory).buffer, SCRATCH_OFFSET, len);
  return new TextDecoder().decode(mem);
}

test("exact integer addition", async () => {
  const ex = await instantiate();
  const len = ex.add_test(5n, 1n, 3n, 1n);
  expect(readScratch(ex, len)).toBe("8");
});

test("exact rational addition reduces", async () => {
  const ex = await instantiate();
  // 1/2 + 1/3 = 5/6
  const len = ex.add_test(1n, 2n, 1n, 3n);
  expect(readScratch(ex, len)).toBe("5/6");
});

test("rational that reduces to integer", async () => {
  const ex = await instantiate();
  // 1/2 + 1/2 = 1
  const len = ex.add_test(1n, 2n, 1n, 2n);
  expect(readScratch(ex, len)).toBe("1");
});

test("negative results", async () => {
  const ex = await instantiate();
  // 3 + (-10) = -7
  const len = ex.add_test(3n, 1n, -10n, 1n);
  expect(readScratch(ex, len)).toBe("-7");
});

test("multiplication of fractions", async () => {
  const ex = await instantiate();
  // 2/3 * 3/4 = 1/2
  const len = ex.mul_test(2n, 3n, 3n, 4n);
  expect(readScratch(ex, len)).toBe("1/2");
});

test("division yields exact rational", async () => {
  const ex = await instantiate();
  // 1 / 3 = 1/3
  const len = ex.div_test(1n, 1n, 3n, 1n);
  expect(readScratch(ex, len)).toBe("1/3");
});

test("large integer in i64 range", async () => {
  const ex = await instantiate();
  const len = ex.add_test(1000000000000n, 1n, 1n, 1n);
  expect(readScratch(ex, len)).toBe("1000000000001");
});
