// The Pyret WASM runtime, built as binaryen IR functions added to a module.
//
// Phase A number tower: exact integers (i64 fixnums), exact rationals
// (i64/i64, reduced, den>0), and roughnums (f64), with Pyret's contagion rules
// (rough is contagious; otherwise stay exact). Bignum promotion is Phase B.
//
// I/O across the JS boundary uses linear memory: number->string writes UTF-8
// into a scratch region and returns (offset is fixed, length returned).

import binaryen from "binaryen";
import { type RtTypes, NUM_TAG } from "./types.ts";

// Fixed scratch region in linear memory for marshalling strings to the host.
export const SCRATCH_OFFSET = 1024;

// Stoppable codegen: number of yield-check ticks between event-loop yields.
// Each instrumented function/lambda entry burns one tick; when gas hits 0 the
// computation pauses (captures its continuation) and returns to the JS driver.
export const GAS_RESET = 100000;

export class Runtime {
  m: binaryen.Module;
  t: RtTypes;

  constructor(m: binaryen.Module, t: RtTypes) {
    this.m = m;
    this.t = t;
  }

  // ---- small helpers over the binaryen builder ----
  private tag(numExpr: number): number {
    return this.m.struct.get(0, numExpr, binaryen.i32, false);
  }
  private mkFixCall(v: number): number {
    return this.m.call("$make_fix", [v], this.t.FixnumRef);
  }

  // Host imports the runtime depends on (provided by src/runtime/run.ts).
  private buildImports() {
    const m = this.m;
    const pair = binaryen.createType([binaryen.i32, binaryen.i32]);
    m.addFunctionImport("$print", "host", "print", pair, binaryen.none);
    m.addFunctionImport("$check_stash", "host", "check_stash", pair, binaryen.none);
    m.addFunctionImport("$check_fail", "host", "check_fail", pair, binaryen.none);
    m.addFunctionImport("$check_fail_isnot", "host", "check_fail_isnot", pair, binaryen.none);
    m.addFunctionImport("$check_fail_pred", "host", "check_fail_pred", pair, binaryen.none);
    m.addFunctionImport("$check_summary", "host", "check_summary", pair, binaryen.none);
    // raise(ptr,len): host throws a PyretError with the message; never returns.
    m.addFunctionImport("$raise", "host", "raise", pair, binaryen.none);
    // check_raises(ptr,len)->i32: host runs the pending thunk in try/catch and
    // returns 1 iff it raised an error whose message contains the expected text.
    m.addFunctionImport("$check_raises", "host", "check_raises", pair, binaryen.i32);
    // emit_byte(b): append a byte to the host output buffer (for the Pyret-written
    // WASM encoder — the self-hosting path). The host collects the .wasm bytes.
    m.addFunctionImport("$emit_byte", "host", "emit_byte",
      binaryen.createType([binaryen.i32]), binaryen.none);
    // do_pause(): host throws a PauseSignal to unwind back to the trampoline
    // driver (stoppable codegen). Never returns. No-op import for normal runs.
    m.addFunctionImport("$do_pause", "host", "do_pause",
      binaryen.createType([]), binaryen.none);
    // read_source_into(addr)->len: host writes the program source bytes into linear
    // memory at addr and returns the byte length. Used by the `read-source`
    // intrinsic so the SELF-HOSTED compiler (a Pyret program compiled to WASM)
    // can receive runtime source. Empty for normal runs.
    m.addFunctionImport("$read_source_into", "host", "read_source_into",
      binaryen.createType([binaryen.i32]), binaryen.i32);
  }

  // $num_to_i32(anyref) -> i32 : low 32 bits of a fixnum (used by emit-byte etc.)
  private buildNumToI32() {
    const m = this.m, t = this.t;
    m.addFunction("$num_to_i32", binaryen.createType([binaryen.anyref]), binaryen.i32, [],
      m.i32.wrap(m.struct.get(1, m.ref.cast(m.local.get(0, binaryen.anyref), t.FixnumRef), binaryen.i64, false)));
  }

  // String inspection ops for the (eventual) Pyret-written lexer: length and
  // string->code-points (builds a Pyret List of code-point numbers). List cells
  // are built with the runtime's link/empty ids (set by the compiler at startup).
  private buildStringOps() {
    const m = this.m, t = this.t, I = binaryen.i32, L = binaryen.i64;
    const nameStr = (s: string) =>
      m.array.new_fixed(t.Str, Array.from(s, (c) => m.i32.const(c.charCodeAt(0))));

    // $string_length(s) -> Fixnum (byte length)
    m.addFunction("$string_length", binaryen.createType([t.StrRef]), t.FixnumRef, [],
      m.call("$make_fix", [m.i64.extend_u(m.array.len(m.local.get(0, t.StrRef)))], t.FixnumRef));

    // $empty_list() -> Variant   (the List `empty`)
    m.addFunction("$empty_list", binaryen.createType([]), t.VariantRef, [],
      m.call("$make_variant",
        [m.global.get("$empty_id", I), nameStr("empty"), m.ref.null(t.FieldsRefNull)], t.VariantRef));

    // $cons(head, tail) -> Variant   (the List `link`)
    m.addFunction("$cons", binaryen.createType([binaryen.anyref, binaryen.anyref]), t.VariantRef, [],
      m.call("$make_variant", [m.global.get("$link_id", I), nameStr("link"),
        m.array.new_fixed(t.Fields, [m.local.get(0, binaryen.anyref), m.local.get(1, binaryen.anyref)])],
        t.VariantRef));

    // $str_to_codepoints(s) -> List<Number>  (build from the end so order holds)
    {
      const s = () => m.local.get(0, t.StrRef);
      const i = () => m.local.get(1, I), acc = () => m.local.get(2, binaryen.anyref);
      m.addFunction("$str_to_codepoints", binaryen.createType([t.StrRef]), binaryen.anyref,
        [I, binaryen.anyref], m.block(null, [
          m.local.set(2, m.call("$empty_list", [], t.VariantRef)),
          m.local.set(1, m.i32.sub(m.array.len(s()), m.i32.const(1))),
          m.block("done", [m.loop("lp", m.block(null, [
            m.if(m.i32.lt_s(i(), m.i32.const(0)), m.br("done")),
            m.local.set(2, m.call("$cons",
              [m.call("$make_fix", [m.i64.extend_u(m.array.get(s(), i(), I, false))], t.FixnumRef), acc()],
              t.VariantRef)),
            m.local.set(1, m.i32.sub(i(), m.i32.const(1))),
            m.br("lp"),
          ]))]),
          acc(),
        ], binaryen.anyref));
    }
    void L;
  }

  // Integer quotient/modulo with FLOOR semantics (Pyret's num-modulo), fixnum
  // range. Used by the Pyret-written WASM encoder (LEB128). a,b : $Num fixnums.
  private buildIntOps() {
    const m = this.m, t = this.t, L = binaryen.i64;
    const fix = (i: number) => m.struct.get(1, m.ref.cast(m.local.get(i, t.NumRef), t.FixnumRef), L, false);
    // floor div: q = a/b ; if remainder!=0 and signs differ, q-1
    const a = () => m.local.get(2, L), b = () => m.local.get(3, L);
    const q = () => m.local.get(4, L), r = () => m.local.get(5, L);
    const setup = () => [m.local.set(2, fix(0)), m.local.set(3, fix(1))];
    const signsDiffer = m.i32.ne(m.i64.lt_s(r(), m.i64.const(0n)), m.i64.lt_s(b(), m.i64.const(0n)));

    m.addFunction("$num_quotient", binaryen.createType([t.NumRef, t.NumRef]), t.NumRef, [L, L, L, L],
      m.block(null, [
        ...setup(),
        m.local.set(4, m.i64.div_s(a(), b())),
        m.local.set(5, m.i64.rem_s(a(), b())),
        m.if(m.i32.and(m.i64.ne(r(), m.i64.const(0n)), signsDiffer),
          m.local.set(4, m.i64.sub(q(), m.i64.const(1n)))),
        m.call("$make_fix", [q()], t.FixnumRef),
      ], t.FixnumRef));

    // floor modulo: r = a - b*floor(a/b); result has sign of b
    m.addFunction("$num_modulo", binaryen.createType([t.NumRef, t.NumRef]), t.NumRef, [L, L, L, L],
      m.block(null, [
        ...setup(),
        m.local.set(5, m.i64.rem_s(a(), b())),
        m.if(m.i32.and(m.i64.ne(r(), m.i64.const(0n)), signsDiffer),
          m.local.set(5, m.i64.add(r(), b()))),
        m.call("$make_fix", [r()], t.FixnumRef),
      ], t.FixnumRef));
  }

  // Build a function that writes `message` to scratch, calls host raise, then
  // traps. Typed to return `retType` so it can be used in expression position.
  private buildRaiser(name: string, message: string, retType: binaryen.Type) {
    const m = this.m;
    m.addFunction(name, binaryen.createType([]), retType, [], m.block(null, [
      ...this.writeLiteral(0, message),
      m.call("$raise", [m.i32.const(SCRATCH_OFFSET), m.i32.const(new TextEncoder().encode(message).length)], binaryen.none),
      m.unreachable(),
    ], retType));
  }

  build() {
    const m = this.m;
    const t = this.t;
    const I = binaryen.i32, L = binaryen.i64, F = binaryen.f64;

    this.buildImports();

    // ---- constructors ----
    // $make_fix(i64) -> (ref $Fixnum)
    m.addFunction("$make_fix", binaryen.createType([L]), t.FixnumRef, [],
      m.struct.new([m.i32.const(NUM_TAG.FIX), m.local.get(0, L)], t.Fixnum));

    // $make_rough(f64) -> (ref $Roughnum)
    m.addFunction("$make_rough", binaryen.createType([F]), t.RoughnumRef, [],
      m.struct.new([m.i32.const(NUM_TAG.ROUGH), m.local.get(0, F)], t.Roughnum));

    // $gcd(i64,i64)->i64  (non-negative; assumes inputs may be negative)
    // iterative Euclid on absolute values
    this.buildGcd();

    // $make_rat(i64 num, i64 den) -> (ref $Num)
    // normalizes: den>0, reduced; if den==1 returns a Fixnum, den==0 traps.
    this.buildMakeRat();

    // $to_f64(ref $Num) -> f64
    this.buildToF64();

    // bignum integers (arbitrary precision)
    this.buildBignum();

    // arithmetic
    this.buildArith();

    // equality on numbers
    this.buildNumEqual();
    this.buildNumCompare();

    // number -> decimal string into scratch memory; returns byte length
    this.buildNumToString();

    this.buildNumToI32();
    this.buildIntOps();

    // strings
    this.buildStrings();

    // type-dispatching operators
    this.buildDispatch();

    // ids of List's link/empty variants, set by the compiler at startup, so the
    // renderer can show lists as [list: ...]. -1 until set.
    m.addGlobal("$link_id", I, true, m.i32.const(-1));
    m.addGlobal("$empty_id", I, true, m.i32.const(-1));
    // thunk awaiting a `raises` check (host invokes run_pending_thunk in try/catch)
    m.addGlobal("$pending_thunk", binaryen.anyref, true, m.ref.null(binaryen.anyref));
    // stoppable codegen: gas counter (yield-check decrements; pause at 0),
    // the captured continuation thunk to resume, and the final result.
    m.addGlobal("$gas", I, true, m.i32.const(GAS_RESET));
    m.addGlobal("$paused_thunk", binaryen.anyref, true, m.ref.null(binaryen.anyref));
    m.addGlobal("$result", binaryen.anyref, true, m.ref.null(binaryen.anyref));

    // universal value -> string (cursor-based renderer) + variant machinery
    this.buildRender();
    this.buildVariants();
    this.buildStringOps();

    // check-block testing support
    this.buildChecks();

    // objects
    this.buildObjects();

    // runtime error raisers (Pyret-style messages via host)
    this.buildRaiser("$err_div_zero", "The left side of `/` was divided by zero", t.NumRef);
    this.buildRaiser("$cases_no_match", "cases: no branch matched the provided value", binaryen.anyref);
    this.buildRaiser("$no_branch", "if: no branch was true and there was no `else`", binaryen.anyref);
    this.buildRaiser("$err_no_field", "object does not have the requested field", binaryen.anyref);
  }

  private buildObjects() {
    const m = this.m, t = this.t, I = binaryen.i32;
    // $make_object(names, values) -> $Object
    m.addFunction("$make_object", binaryen.createType([t.NamesRef, t.FieldsRef]), t.ObjectRef, [],
      m.struct.new([m.local.get(0, t.NamesRef), m.local.get(1, t.FieldsRef)], t.Object));
    // $make_method(closure) -> $Method
    m.addFunction("$make_method", binaryen.createType([t.ClosureRef]), t.MethodRef, [],
      m.struct.new([m.local.get(0, t.ClosureRef)], t.Method));
    // $method_closure(method) -> $Closure
    m.addFunction("$method_closure", binaryen.createType([t.MethodRef]), t.ClosureRef, [],
      m.struct.get(0, m.local.get(0, t.MethodRef), t.ClosureRef, false));
    // $obj_get(obj, name) -> anyref  (linear scan; raises if absent)
    {
      const obj = () => m.local.get(0, t.ObjectRef);
      const name = () => m.local.get(1, t.StrRef);
      const names = () => m.local.get(2, t.NamesRef);
      const i = () => m.local.get(3, I), n = () => m.local.get(4, I);
      const body = m.block("ret", [
        m.local.set(2, m.struct.get(0, obj(), t.NamesRef, false)),
        m.local.set(4, m.array.len(names())),
        m.local.set(3, m.i32.const(0)),
        m.block("done", [m.loop("lp", m.block(null, [
          m.if(m.i32.ge_s(i(), n()), m.br("done")),
          m.if(m.call("$str_equal", [m.array.get(names(), i(), t.StrRef, false), name()], I),
            m.br("ret", undefined, m.array.get(m.struct.get(1, obj(), t.FieldsRef, false), i(), binaryen.anyref, false))),
          m.local.set(3, m.i32.add(i(), m.i32.const(1))),
          m.br("lp"),
        ]))]),
        m.call("$err_no_field", [], binaryen.anyref),
      ], binaryen.anyref);
      m.addFunction("$obj_get", binaryen.createType([t.ObjectRef, t.StrRef]), binaryen.anyref, [t.NamesRef, I, I], body);
    }
    // $obj_equal(a, b) -> i32  (same field names in order, values equal)
    {
      const a = () => m.local.get(0, t.ObjectRef), b = () => m.local.get(1, t.ObjectRef);
      const na = () => m.local.get(2, t.NamesRef), nb = () => m.local.get(3, t.NamesRef);
      const i = () => m.local.get(4, I), n = () => m.local.get(5, I);
      const body = m.block("ret", [
        m.local.set(2, m.struct.get(0, a(), t.NamesRef, false)),
        m.local.set(3, m.struct.get(0, b(), t.NamesRef, false)),
        m.local.set(5, m.array.len(na())),
        m.if(m.i32.ne(n(), m.array.len(nb())), m.br("ret", undefined, m.i32.const(0))),
        m.local.set(4, m.i32.const(0)),
        m.block("done", [m.loop("lp", m.block(null, [
          m.if(m.i32.ge_s(i(), n()), m.br("done")),
          m.if(m.i32.eqz(m.call("$str_equal", [m.array.get(na(), i(), t.StrRef, false), m.array.get(nb(), i(), t.StrRef, false)], I)),
            m.br("ret", undefined, m.i32.const(0))),
          m.if(m.i32.eqz(m.call("$equal", [
              m.array.get(m.struct.get(1, a(), t.FieldsRef, false), i(), binaryen.anyref, false),
              m.array.get(m.struct.get(1, b(), t.FieldsRef, false), i(), binaryen.anyref, false)], I)),
            m.br("ret", undefined, m.i32.const(0))),
          m.local.set(4, m.i32.add(i(), m.i32.const(1))),
          m.br("lp"),
        ]))]),
        m.i32.const(1),
      ], I);
      m.addFunction("$obj_equal", binaryen.createType([t.ObjectRef, t.ObjectRef]), I, [t.NamesRef, t.NamesRef, I, I], body);
    }
    // $render_object(obj, addr) -> end addr   {name: value, ...}
    {
      const obj = () => m.local.get(0, t.ObjectRef);
      const a = () => m.local.get(1, I);
      const names = () => m.local.get(2, t.NamesRef);
      const i = () => m.local.get(3, I), n = () => m.local.get(4, I);
      const body = m.block(null, [
        m.local.set(2, m.struct.get(0, obj(), t.NamesRef, false)),
        m.local.set(4, m.array.len(names())),
        m.i32.store8(0, 0, a(), m.i32.const(123)), // '{'
        m.local.set(1, m.i32.add(a(), m.i32.const(1))),
        m.local.set(3, m.i32.const(0)),
        m.block("done", [m.loop("lp", m.block(null, [
          m.if(m.i32.ge_s(i(), n()), m.br("done")),
          m.if(m.i32.gt_s(i(), m.i32.const(0)), m.block(null, [
            m.i32.store8(0, 0, a(), m.i32.const(44)), m.i32.store8(0, 0, m.i32.add(a(), m.i32.const(1)), m.i32.const(32)),
            m.local.set(1, m.i32.add(a(), m.i32.const(2))),
          ])),
          m.local.set(1, m.i32.add(a(), m.call("$str_copy", [m.array.get(names(), i(), t.StrRef, false), a()], I))),
          m.i32.store8(0, 0, a(), m.i32.const(58)), m.i32.store8(0, 0, m.i32.add(a(), m.i32.const(1)), m.i32.const(32)), // ': '
          m.local.set(1, m.i32.add(a(), m.i32.const(2))),
          m.local.set(1, m.call("$render", [m.array.get(m.struct.get(1, obj(), t.FieldsRef, false), i(), binaryen.anyref, false), a()], I)),
          m.local.set(3, m.i32.add(i(), m.i32.const(1))),
          m.br("lp"),
        ]))]),
        m.i32.store8(0, 0, a(), m.i32.const(125)), // '}'
        m.i32.add(a(), m.i32.const(1)),
      ], I);
      m.addFunction("$render_object", binaryen.createType([t.ObjectRef, I]), I, [t.NamesRef, I, I], body);
    }
  }

  private buildChecks() {
    const m = this.m, I = binaryen.i32;
    m.addGlobal("$passed", I, true, m.i32.const(0));
    m.addGlobal("$total", I, true, m.i32.const(0));
    // $check_is(a, b): total++; equal? passed++ : report failure (stash a, fail b)
    const a = () => m.local.get(0, binaryen.anyref);
    const b = () => m.local.get(1, binaryen.anyref);
    const lenLocal = () => m.local.get(2, I);
    const body = m.block(null, [
      m.global.set("$total", m.i32.add(m.global.get("$total", I), m.i32.const(1))),
      m.if(m.call("$equal", [a(), b()], I),
        m.global.set("$passed", m.i32.add(m.global.get("$passed", I), m.i32.const(1))),
        m.block(null, [
          m.local.set(2, m.call("$val_to_string", [a()], I)),
          m.call("$check_stash", [m.i32.const(SCRATCH_OFFSET), lenLocal()], binaryen.none),
          m.local.set(2, m.call("$val_to_string", [b()], I)),
          m.call("$check_fail", [m.i32.const(SCRATCH_OFFSET), lenLocal()], binaryen.none),
        ])),
    ]);
    m.addFunction("$check_is", binaryen.createType([binaryen.anyref, binaryen.anyref]), binaryen.none, [I], body);

    // $check_is_not(a, b): total++; (not equal)? passed++ : report
    const body2 = m.block(null, [
      m.global.set("$total", m.i32.add(m.global.get("$total", I), m.i32.const(1))),
      m.if(m.i32.eqz(m.call("$equal", [a(), b()], I)),
        m.global.set("$passed", m.i32.add(m.global.get("$passed", I), m.i32.const(1))),
        m.block(null, [
          m.local.set(2, m.call("$val_to_string", [a()], I)),
          m.call("$check_stash", [m.i32.const(SCRATCH_OFFSET), lenLocal()], binaryen.none),
          m.local.set(2, m.call("$val_to_string", [b()], I)),
          m.call("$check_fail_isnot", [m.i32.const(SCRATCH_OFFSET), lenLocal()], binaryen.none),
        ])),
    ]);
    m.addFunction("$check_is_not", binaryen.createType([binaryen.anyref, binaryen.anyref]), binaryen.none, [I], body2);

    // $check_pred(passed_i32): total++; cond? passed++ : report a satisfies failure
    {
      const cond = () => m.local.get(0, I);
      m.addFunction("$check_pred", binaryen.createType([I]), binaryen.none, [], m.block(null, [
        m.global.set("$total", m.i32.add(m.global.get("$total", I), m.i32.const(1))),
        m.if(cond(),
          m.global.set("$passed", m.i32.add(m.global.get("$passed", I), m.i32.const(1))),
          m.call("$check_fail_pred", [m.i32.const(0), m.i32.const(0)], binaryen.none)),
      ]));
    }
  }

  private buildStrings() {
    const m = this.m, t = this.t, I = binaryen.i32;
    // $str_to_scratch(ref $Str) -> i32 length, copies bytes to SCRATCH_OFFSET
    {
      const s = () => m.local.get(0, t.StrRef);
      const i = () => m.local.get(1, I), len = () => m.local.get(2, I);
      const body = m.block(null, [
        m.local.set(2, m.array.len(s())),
        m.local.set(1, m.i32.const(0)),
        m.block("done", [
          m.loop("lp", m.block(null, [
            m.if(m.i32.ge_s(i(), len()), m.br("done")),
            m.i32.store8(0, 0, m.i32.add(m.i32.const(SCRATCH_OFFSET), i()),
              m.array.get(s(), i(), I, false)),
            m.local.set(1, m.i32.add(i(), m.i32.const(1))),
            m.br("lp"),
          ])),
        ]),
        len(),
      ], I);
      m.addFunction("$str_to_scratch", binaryen.createType([t.StrRef]), I, [I, I], body);
    }
    // $str_from_mem(addr, len) -> ref $Str  (copies linear-memory bytes into a $Str)
    {
      const addr = () => m.local.get(0, I), len = () => m.local.get(1, I);
      const i = () => m.local.get(2, I), res = () => m.local.get(3, t.StrRef);
      const body = m.block(null, [
        m.local.set(3, m.array.new(t.Str, len(), m.i32.const(0))),
        m.local.set(2, m.i32.const(0)),
        m.block("done", [m.loop("lp", m.block(null, [
          m.if(m.i32.ge_s(i(), len()), m.br("done")),
          m.array.set(res(), i(), m.i32.load8_u(0, 0, m.i32.add(addr(), i()))),
          m.local.set(2, m.i32.add(i(), m.i32.const(1))),
          m.br("lp"),
        ]))]),
        res(),
      ], t.StrRef);
      m.addFunction("$str_from_mem", binaryen.createType([I, I]), t.StrRef, [I, t.StrRef], body);
    }
    // $tostring(anyref) -> ref $Str  (renders, then builds a string value)
    {
      const len = () => m.local.get(1, I);
      const body = m.block(null, [
        m.local.set(1, m.call("$val_to_string", [m.local.get(0, binaryen.anyref)], I)),
        m.call("$str_from_mem", [m.i32.const(SCRATCH_OFFSET), len()], t.StrRef),
      ], t.StrRef);
      m.addFunction("$tostring", binaryen.createType([binaryen.anyref]), t.StrRef, [I], body);
    }
    // $str_concat(ref $Str, ref $Str) -> ref $Str
    {
      const a = () => m.local.get(0, t.StrRef), b = () => m.local.get(1, t.StrRef);
      const la = () => m.local.get(2, I), lb = () => m.local.get(3, I), res = () => m.local.get(4, t.StrRef);
      const body = m.block(null, [
        m.local.set(2, m.array.len(a())),
        m.local.set(3, m.array.len(b())),
        m.local.set(4, m.array.new(t.Str, m.i32.add(la(), lb()), m.i32.const(0))),
        m.array.copy(res(), m.i32.const(0), a(), m.i32.const(0), la()),
        m.array.copy(res(), la(), b(), m.i32.const(0), lb()),
        res(),
      ], t.StrRef);
      m.addFunction("$str_concat", binaryen.createType([t.StrRef, t.StrRef]), t.StrRef, [I, I, t.StrRef], body);
    }
    // $str_equal(ref $Str, ref $Str) -> i32
    {
      const a = () => m.local.get(0, t.StrRef), b = () => m.local.get(1, t.StrRef);
      const la = () => m.local.get(2, I), i = () => m.local.get(3, I);
      const body = m.block("ret", [
        m.local.set(2, m.array.len(a())),
        m.if(m.i32.ne(la(), m.array.len(b())), m.br("ret", undefined, m.i32.const(0))),
        m.local.set(3, m.i32.const(0)),
        m.block("done", [
          m.loop("lp", m.block(null, [
            m.if(m.i32.ge_s(i(), la()), m.br("done")),
            m.if(m.i32.ne(m.array.get(a(), i(), I, false), m.array.get(b(), i(), I, false)),
              m.br("ret", undefined, m.i32.const(0))),
            m.local.set(3, m.i32.add(i(), m.i32.const(1))),
            m.br("lp"),
          ])),
        ]),
        m.i32.const(1),
      ], I);
      m.addFunction("$str_equal", binaryen.createType([t.StrRef, t.StrRef]), I, [I, I], body);
    }
  }

  // Type-dispatching `+` and `==` over the anyref universe.
  private buildDispatch() {
    const m = this.m, t = this.t;
    {
      const a = () => m.local.get(0, binaryen.anyref), b = () => m.local.get(1, binaryen.anyref);
      const body = m.if(m.ref.test(a(), t.StrRefNull),
        m.call("$str_concat", [m.ref.cast(a(), t.StrRef), m.ref.cast(b(), t.StrRef)], t.StrRef),
        m.call("$num_add", [m.ref.cast(a(), t.NumRef), m.ref.cast(b(), t.NumRef)], t.NumRef),
        binaryen.anyref);
      m.addFunction("$plus", binaryen.createType([binaryen.anyref, binaryen.anyref]), binaryen.anyref, [], body);
    }
    {
      const a = () => m.local.get(0, binaryen.anyref), b = () => m.local.get(1, binaryen.anyref);
      const I = binaryen.i32;
      const eq0 = m.i32.const(0);
      const body = m.if(m.ref.test(a(), t.StrRefNull),
        m.if(m.ref.test(b(), t.StrRefNull),
          m.call("$str_equal", [m.ref.cast(a(), t.StrRef), m.ref.cast(b(), t.StrRef)], I), eq0, I),
        m.if(m.ref.test(a(), t.NumRefNull),
          m.if(m.ref.test(b(), t.NumRefNull),
            m.call("$num_equal", [m.ref.cast(a(), t.NumRef), m.ref.cast(b(), t.NumRef)], I), eq0, I),
          m.if(m.ref.test(a(), t.VariantRefNull),
            m.if(m.ref.test(b(), t.VariantRefNull),
              m.call("$variant_equal", [m.ref.cast(a(), t.VariantRef), m.ref.cast(b(), t.VariantRef)], I), eq0, I),
            m.if(m.ref.test(a(), t.ObjectRefNull),
              m.if(m.ref.test(b(), t.ObjectRefNull),
                m.call("$obj_equal", [m.ref.cast(a(), t.ObjectRef), m.ref.cast(b(), t.ObjectRef)], I), eq0, I),
              // i31 bools/nothing: reference identity
              m.ref.eq(m.ref.cast(a(), binaryen.eqref), m.ref.cast(b(), binaryen.eqref)), I),
            I),
          I),
        I);
      m.addFunction("$equal", binaryen.createType([binaryen.anyref, binaryen.anyref]), binaryen.i32, [], body);
    }
  }

  // Emit a sequence of i32.store8 writing the ASCII of `s` starting at
  // SCRATCH_OFFSET + base. Returns the binaryen statements.
  private writeLiteral(base: number, s: string): number[] {
    const m = this.m;
    const out: number[] = [];
    for (let i = 0; i < s.length; i++) {
      out.push(m.i32.store8(0, 0, m.i32.const(SCRATCH_OFFSET + base + i), m.i32.const(s.charCodeAt(i))));
    }
    return out;
  }

  // $val_to_string(anyref) -> i32 length written at SCRATCH_OFFSET.
  // Numbers via $num_to_string; i31 immediates are booleans/nothing.
  // Stores ASCII of `s` at (addrLocal + i). Returns the store statements.
  private litAt(addrLocal: number, s: string): number[] {
    const m = this.m, I = binaryen.i32;
    return Array.from(s, (ch, i) =>
      m.i32.store8(0, 0, m.i32.add(m.local.get(addrLocal, I), m.i32.const(i)), m.i32.const(ch.charCodeAt(0))));
  }

  private buildRender() {
    const m = this.m, t = this.t, I = binaryen.i32;

    // $str_copy(ref $Str, addr) -> i32 length
    {
      const s = () => m.local.get(0, t.StrRef);
      const addr = () => m.local.get(1, I);
      const i = () => m.local.get(2, I), len = () => m.local.get(3, I);
      const body = m.block(null, [
        m.local.set(3, m.array.len(s())),
        m.local.set(2, m.i32.const(0)),
        m.block("done", [m.loop("lp", m.block(null, [
          m.if(m.i32.ge_s(i(), len()), m.br("done")),
          m.i32.store8(0, 0, m.i32.add(addr(), i()), m.array.get(s(), i(), I, false)),
          m.local.set(2, m.i32.add(i(), m.i32.const(1))),
          m.br("lp"),
        ]))]),
        len(),
      ], I);
      m.addFunction("$str_copy", binaryen.createType([t.StrRef, I]), I, [I, I], body);
    }

    // $render(v anyref, addr i32) -> end addr
    {
      const v = () => m.local.get(0, binaryen.anyref);
      const addr = () => m.local.get(1, I);
      const b = () => m.i31.get_s(m.ref.cast(v(), binaryen.i31ref));
      const body = m.block("ret", [
        m.if(m.ref.test(v(), t.StrRefNull),
          m.br("ret", undefined, m.i32.add(addr(), m.call("$str_copy", [m.ref.cast(v(), t.StrRef), addr()], I)))),
        m.if(m.ref.test(v(), t.NumRefNull),
          m.br("ret", undefined, m.call("$render_num", [m.ref.cast(v(), t.NumRef), addr()], I))),
        m.if(m.ref.test(v(), t.VariantRefNull),
          m.br("ret", undefined, m.call("$render_variant", [m.ref.cast(v(), t.VariantRef), addr()], I))),
        m.if(m.ref.test(v(), t.ObjectRefNull),
          m.br("ret", undefined, m.call("$render_object", [m.ref.cast(v(), t.ObjectRef), addr()], I))),
        // i31: 1 true, 0 false, else nothing
        m.if(m.i32.eq(b(), m.i32.const(1)),
          m.block(null, [...this.litAt(1, "true"), m.br("ret", undefined, m.i32.add(addr(), m.i32.const(4)))])),
        m.if(m.i32.eq(b(), m.i32.const(0)),
          m.block(null, [...this.litAt(1, "false"), m.br("ret", undefined, m.i32.add(addr(), m.i32.const(5)))])),
        ...this.litAt(1, "nothing"),
        m.br("ret", undefined, m.i32.add(addr(), m.i32.const(7))),
      ], I);
      m.addFunction("$render", binaryen.createType([binaryen.anyref, I]), I, [], body);
    }

    // $render_variant(v $Variant, addr) -> end addr.  name "(" f0 ", " f1 ... ")"
    {
      const v = () => m.local.get(0, t.VariantRef);
      const a = () => m.local.get(2, I);
      const fields = () => m.local.get(3, t.FieldsRefNull);
      const i = () => m.local.get(4, I), n = () => m.local.get(5, I);
      const body = m.block("ret", [
        // tuple (reserved id 0): render as {a; b; c}
        m.if(m.i32.eqz(m.struct.get(0, v(), I, false)),
          m.br("ret", undefined, m.call("$render_tuple", [v(), m.local.get(1, I)], I))),
        // list-aware: link/empty render as [list: ...]
        m.if(m.i32.or(
          m.i32.eq(m.struct.get(0, v(), I, false), m.global.get("$link_id", I)),
          m.i32.eq(m.struct.get(0, v(), I, false), m.global.get("$empty_id", I))),
          m.br("ret", undefined, m.call("$render_list", [v(), m.local.get(1, I)], I))),
        m.local.set(2, m.i32.add(m.local.get(1, I),
          m.call("$str_copy", [m.struct.get(1, v(), t.StrRef, false), m.local.get(1, I)], I))),
        m.local.set(3, m.struct.get(2, v(), t.FieldsRefNull, false)),
        m.if(m.ref.is_null(fields()), m.br("ret", undefined, a())),
        m.local.set(5, m.array.len(fields())),
        m.if(m.i32.eqz(n()), m.br("ret", undefined, a())),
        m.i32.store8(0, 0, a(), m.i32.const(40)), // '('
        m.local.set(2, m.i32.add(a(), m.i32.const(1))),
        m.local.set(4, m.i32.const(0)),
        m.block("done", [m.loop("lp", m.block(null, [
          m.if(m.i32.ge_s(i(), n()), m.br("done")),
          m.if(m.i32.gt_s(i(), m.i32.const(0)), m.block(null, [
            m.i32.store8(0, 0, a(), m.i32.const(44)), // ','
            m.i32.store8(0, 0, m.i32.add(a(), m.i32.const(1)), m.i32.const(32)), // ' '
            m.local.set(2, m.i32.add(a(), m.i32.const(2))),
          ])),
          m.local.set(2, m.call("$render", [m.array.get(fields(), i(), binaryen.anyref, false), a()], I)),
          m.local.set(4, m.i32.add(i(), m.i32.const(1))),
          m.br("lp"),
        ]))]),
        m.i32.store8(0, 0, a(), m.i32.const(41)), // ')'
        m.br("ret", undefined, m.i32.add(a(), m.i32.const(1))),
      ], I);
      m.addFunction("$render_variant", binaryen.createType([t.VariantRef, I]), I,
        [I, t.FieldsRefNull, I, I], body);
    }

    // $render_list(v $Variant, addr) -> end addr.  "[list: a, b, c]"
    {
      const a = () => m.local.get(2, I);       // cursor
      const cur = () => m.local.get(3, t.VariantRef);
      const first = () => m.local.get(4, I);
      const flds = () => m.struct.get(2, cur(), t.FieldsRefNull, false);
      const body = m.block("ret", [
        m.local.set(2, m.local.get(1, I)),
        ...this.litAt(2, "[list: "),
        m.local.set(2, m.i32.add(a(), m.i32.const(7))),
        m.local.set(3, m.local.get(0, t.VariantRef)),
        m.local.set(4, m.i32.const(1)),
        m.block("done", [m.loop("lp", m.block(null, [
          m.if(m.i32.eq(m.struct.get(0, cur(), I, false), m.global.get("$empty_id", I)), m.br("done")),
          m.if(m.i32.eqz(first()), m.block(null, [
            m.i32.store8(0, 0, a(), m.i32.const(44)),                       // ','
            m.i32.store8(0, 0, m.i32.add(a(), m.i32.const(1)), m.i32.const(32)), // ' '
            m.local.set(2, m.i32.add(a(), m.i32.const(2))),
          ])),
          m.local.set(4, m.i32.const(0)),
          m.local.set(2, m.call("$render", [m.array.get(flds(), m.i32.const(0), binaryen.anyref, false), a()], I)),
          m.local.set(3, m.ref.cast(m.array.get(flds(), m.i32.const(1), binaryen.anyref, false), t.VariantRef)),
          m.br("lp"),
        ]))]),
        m.i32.store8(0, 0, a(), m.i32.const(93)), // ']'
        m.br("ret", undefined, m.i32.add(a(), m.i32.const(1))),
      ], I);
      m.addFunction("$render_list", binaryen.createType([t.VariantRef, I]), I, [I, t.VariantRef, I], body);
    }

    // $render_tuple(v $Variant, addr) -> end addr.  "{a; b; c}"
    {
      const v = () => m.local.get(0, t.VariantRef);
      const a = () => m.local.get(2, I);
      const flds = () => m.local.get(3, t.FieldsRefNull);
      const i = () => m.local.get(4, I), n = () => m.local.get(5, I);
      const body = m.block("ret", [
        m.local.set(2, m.local.get(1, I)),
        m.i32.store8(0, 0, a(), m.i32.const(123)), // '{'
        m.local.set(2, m.i32.add(a(), m.i32.const(1))),
        m.local.set(3, m.struct.get(2, v(), t.FieldsRefNull, false)),
        m.if(m.ref.is_null(flds()), m.block(null, [
          m.i32.store8(0, 0, a(), m.i32.const(125)), // '}'
          m.br("ret", undefined, m.i32.add(a(), m.i32.const(1))),
        ])),
        m.local.set(5, m.array.len(flds())),
        m.local.set(4, m.i32.const(0)),
        m.block("done", [m.loop("lp", m.block(null, [
          m.if(m.i32.ge_s(i(), n()), m.br("done")),
          m.if(m.i32.gt_s(i(), m.i32.const(0)), m.block(null, [
            m.i32.store8(0, 0, a(), m.i32.const(59)),                        // ';'
            m.i32.store8(0, 0, m.i32.add(a(), m.i32.const(1)), m.i32.const(32)), // ' '
            m.local.set(2, m.i32.add(a(), m.i32.const(2))),
          ])),
          m.local.set(2, m.call("$render", [m.array.get(flds(), i(), binaryen.anyref, false), a()], I)),
          m.local.set(4, m.i32.add(i(), m.i32.const(1))),
          m.br("lp"),
        ]))]),
        m.i32.store8(0, 0, a(), m.i32.const(125)), // '}'
        m.br("ret", undefined, m.i32.add(a(), m.i32.const(1))),
      ], I);
      m.addFunction("$render_tuple", binaryen.createType([t.VariantRef, I]), I, [I, t.FieldsRefNull, I, I], body);
    }

    // $val_to_string(v) -> length at SCRATCH_OFFSET
    m.addFunction("$val_to_string", binaryen.createType([binaryen.anyref]), I, [],
      m.i32.sub(m.call("$render", [m.local.get(0, binaryen.anyref), m.i32.const(SCRATCH_OFFSET)], I),
        m.i32.const(SCRATCH_OFFSET)));
  }

  // data variant construction / access / structural equality
  private buildVariants() {
    const m = this.m, t = this.t, I = binaryen.i32;
    // $make_variant(id, name, fields) -> $Variant
    m.addFunction("$make_variant",
      binaryen.createType([I, t.StrRef, t.FieldsRefNull]), t.VariantRef, [],
      m.struct.new([m.local.get(0, I), m.local.get(1, t.StrRef), m.local.get(2, t.FieldsRefNull)], t.Variant));
    // $variant_id(v) -> i32
    m.addFunction("$variant_id", binaryen.createType([t.VariantRef]), I, [],
      m.struct.get(0, m.local.get(0, t.VariantRef), I, false));
    // $variant_field(v, i) -> anyref
    m.addFunction("$variant_field", binaryen.createType([t.VariantRef, I]), binaryen.anyref, [],
      m.array.get(m.struct.get(2, m.local.get(0, t.VariantRef), t.FieldsRefNull, false),
        m.local.get(1, I), binaryen.anyref, false));
    // $variant_equal(a, b) -> i32 (same id and all fields equal)
    {
      const a = () => m.local.get(0, t.VariantRef), b = () => m.local.get(1, t.VariantRef);
      const fa = () => m.local.get(2, t.FieldsRefNull), fb = () => m.local.get(3, t.FieldsRefNull);
      const i = () => m.local.get(4, I), n = () => m.local.get(5, I);
      const body = m.block("ret", [
        m.if(m.i32.ne(m.struct.get(0, a(), I, false), m.struct.get(0, b(), I, false)),
          m.br("ret", undefined, m.i32.const(0))),
        m.local.set(2, m.struct.get(2, a(), t.FieldsRefNull, false)),
        m.local.set(3, m.struct.get(2, b(), t.FieldsRefNull, false)),
        m.if(m.ref.is_null(fa()), m.br("ret", undefined, m.i32.const(1))), // both nullary, same id
        m.local.set(5, m.array.len(fa())),
        m.local.set(4, m.i32.const(0)),
        m.block("done", [m.loop("lp", m.block(null, [
          m.if(m.i32.ge_s(i(), n()), m.br("done")),
          m.if(m.i32.eqz(m.call("$equal",
            [m.array.get(fa(), i(), binaryen.anyref, false), m.array.get(fb(), i(), binaryen.anyref, false)], I)),
            m.br("ret", undefined, m.i32.const(0))),
          m.local.set(4, m.i32.add(i(), m.i32.const(1))),
          m.br("lp"),
        ]))]),
        m.i32.const(1),
      ], I);
      m.addFunction("$variant_equal", binaryen.createType([t.VariantRef, t.VariantRef]), I,
        [t.FieldsRefNull, t.FieldsRefNull, I, I], body);
    }
  }

  private buildGcd() {
    const m = this.m, L = binaryen.i64;
    // locals: 0=a,1=b (params); 2=t
    const a = () => m.local.get(0, L);
    const b = () => m.local.get(1, L);
    const tmp = () => m.local.get(2, L);
    const absL = (e: number) => {
      // (b < 0) ? -b : b  — use select
      return m.select(m.i64.lt_s(e, m.i64.const(0n)), m.i64.sub(m.i64.const(0n), e), e);
    };
    const body = m.block("done", [
      m.local.set(0, absL(a())),
      m.local.set(1, absL(b())),
      m.loop("loop", m.block(null, [
        m.if(m.i64.eqz(b()), m.br("done", undefined, a())), // exit with gcd in `a`
        m.local.set(2, m.i64.rem_s(a(), b())),
        m.local.set(0, b()),
        m.local.set(1, tmp()),
        m.br("loop"),
      ])),
    ], binaryen.i64);
    m.addFunction("$gcd", binaryen.createType([L, L]), binaryen.i64, [L], body);
  }

  private buildMakeRat() {
    const m = this.m, t = this.t, I = binaryen.i32;
    // $int_is_zero / $int_is_one : integer $Num predicates (only Fixnum can be 0/1)
    // only a Fixnum can equal 0/1; guard the cast with an if (i32.and is not
    // short-circuiting, so casting a Bignum to Fixnum would trap).
    const fixEq = (x: number, n: bigint) => m.if(
      m.i32.eq(m.struct.get(0, x, I, false), m.i32.const(NUM_TAG.FIX)),
      m.i64.eq(m.struct.get(1, m.ref.cast(x, t.FixnumRef), binaryen.i64, false), m.i64.const(n)),
      m.i32.const(0), I);
    m.addFunction("$int_is_zero", binaryen.createType([t.NumRef]), I, [], fixEq(m.local.get(0, t.NumRef), 0n));
    m.addFunction("$int_is_one", binaryen.createType([t.NumRef]), I, [], fixEq(m.local.get(0, t.NumRef), 1n));

    // make_rat(num, den) with integer $Num components -> reduced exact number.
    const num = () => m.local.get(0, t.NumRef), den = () => m.local.get(1, t.NumRef);
    const sign = () => m.local.get(2, I);
    const g = () => m.local.get(3, t.LimbsRef);
    const numN = () => m.local.get(4, t.NumRef), denN = () => m.local.get(5, t.NumRef);
    const body = m.block("ret", [
      m.if(m.call("$int_is_zero", [den()], I), m.br("ret", undefined, m.call("$err_div_zero", [], t.NumRef))),
      m.if(m.call("$int_is_zero", [num()], I), m.br("ret", undefined, m.call("$make_fix", [m.i64.const(0n)], t.FixnumRef))),
      m.local.set(2, m.i32.mul(m.call("$int_sign", [num()], I), m.call("$int_sign", [den()], I))),
      m.local.set(3, m.call("$mag_gcd", [m.call("$int_limbs", [num()], t.LimbsRef), m.call("$int_limbs", [den()], t.LimbsRef)], t.LimbsRef)),
      // numN = sign * (|num| / g) ; denN = (|den| / g)  (positive)
      m.local.set(4, m.call("$bn_norm", [sign(), m.call("$mag_divmod", [m.call("$int_limbs", [num()], t.LimbsRef), g()], t.LimbsRef)], t.NumRef)),
      m.local.set(5, m.call("$bn_norm", [m.i32.const(1), m.call("$mag_divmod", [m.call("$int_limbs", [den()], t.LimbsRef), g()], t.LimbsRef)], t.NumRef)),
      m.if(m.call("$int_is_one", [denN()], I), m.br("ret", undefined, numN())),
      m.struct.new([m.i32.const(NUM_TAG.RATIONAL), numN(), denN()], t.Rational),
    ], t.NumRef);
    m.addFunction("$make_rat", binaryen.createType([t.NumRef, t.NumRef]), t.NumRef, [I, t.LimbsRef, t.NumRef, t.NumRef], body);
  }

  private buildToF64() {
    const m = this.m, t = this.t, F = binaryen.f64;
    const I = binaryen.i32;
    // $int_to_f64(num integer) -> f64
    {
      const x = () => m.local.get(0, t.NumRef);
      const limbs = () => m.local.get(1, t.LimbsRef), i = () => m.local.get(2, I), f = () => m.local.get(3, F);
      const isBig = m.i32.eq(m.struct.get(0, x(), I, false), m.i32.const(NUM_TAG.BIGNUM));
      const fixF = m.f64.convert_s.i64(m.struct.get(1, m.ref.cast(x(), t.FixnumRef), binaryen.i64, false));
      const bigBody = m.block("bret", [
        m.local.set(1, m.struct.get(2, m.ref.cast(x(), t.BignumRef), t.LimbsRef, false)),
        m.local.set(3, m.f64.const(0)),
        m.local.set(2, m.array.len(limbs())),
        m.block("done", [m.loop("lp", m.block(null, [
          m.if(m.i32.eqz(i()), m.br("done")),
          m.local.set(2, m.i32.sub(i(), m.i32.const(1))),
          m.local.set(3, m.f64.add(m.f64.mul(f(), m.f64.const(4294967296)),
            m.f64.convert_u.i64(m.i64.extend_u(m.array.get(limbs(), i(), I, false))))),
          m.br("lp"),
        ]))]),
        m.f64.mul(f(), m.f64.convert_s.i32(m.struct.get(1, m.ref.cast(x(), t.BignumRef), I, false))),
      ], F);
      m.addFunction("$int_to_f64", binaryen.createType([t.NumRef]), F, [t.LimbsRef, I, F],
        m.if(isBig, bigBody, fixF, F));
    }
    const x = () => m.local.get(0, t.NumRef);
    const isRough = m.i32.eq(m.struct.get(0, x(), I, false), m.i32.const(NUM_TAG.ROUGH));
    const isRat = m.i32.eq(m.struct.get(0, x(), I, false), m.i32.const(NUM_TAG.RATIONAL));
    const roughVal = m.struct.get(1, m.ref.cast(x(), t.RoughnumRef), F, false);
    const ratVal = m.f64.div(
      m.call("$int_to_f64", [m.struct.get(1, m.ref.cast(x(), t.RationalRef), t.NumRef, false)], F),
      m.call("$int_to_f64", [m.struct.get(2, m.ref.cast(x(), t.RationalRef), t.NumRef, false)], F));
    const body = m.if(isRough, roughVal,
      m.if(isRat, ratVal, m.call("$int_to_f64", [x()], F), F), F);
    m.addFunction("$to_f64", binaryen.createType([t.NumRef]), F, [], body);
  }

  // condition: both numbers are integers (Fixnum or Bignum)
  private bothInt(a: () => number, b: () => number): number {
    const m = this.m;
    const isInt = (x: number) => {
      const tag = m.struct.get(0, x, binaryen.i32, false);
      return m.i32.or(m.i32.eq(tag, m.i32.const(NUM_TAG.FIX)), m.i32.eq(tag, m.i32.const(NUM_TAG.BIGNUM)));
    };
    return m.i32.and(isInt(a()), isInt(b()));
  }

  // Extract numerator/denominator as integer $Num for an exact number.
  private exactNum(x: number) {
    const m = this.m, t = this.t;
    const isRat = m.i32.eq(m.struct.get(0, x, binaryen.i32, false), m.i32.const(NUM_TAG.RATIONAL));
    return m.if(isRat, m.struct.get(1, m.ref.cast(x, t.RationalRef), t.NumRef, false), x, t.NumRef);
  }
  private exactDen(x: number) {
    const m = this.m, t = this.t;
    const isRat = m.i32.eq(m.struct.get(0, x, binaryen.i32, false), m.i32.const(NUM_TAG.RATIONAL));
    return m.if(isRat, m.struct.get(2, m.ref.cast(x, t.RationalRef), t.NumRef, false),
      m.call("$make_fix", [m.i64.const(1n)], t.FixnumRef), t.NumRef);
  }

  // ===== Arbitrary-precision integer (bignum) support =====
  // Magnitudes are i32-limb arrays, little-endian, base 2^32, normalized to no
  // high zero limbs (len 0 == zero). Bignums never represent 0 (that's Fixnum).
  private buildBignum() {
    const m = this.m, t = this.t, I = binaryen.i32, L = binaryen.i64;
    const ue = (e: number) => m.i64.extend_u(e); // i32 limb -> unsigned i64
    const limb = (arr: number, i: number) => m.array.get(arr, i, I, false);

    // $mag_norm(limbs) -> limbs   (trim high zero limbs)
    {
      const a = () => m.local.get(0, t.LimbsRef);
      const i = () => m.local.get(1, I), res = () => m.local.get(2, t.LimbsRef);
      const body = m.block("ret", [
        m.local.set(1, m.array.len(a())),
        // decrement i while i>0 and a[i-1]==0
        m.block("done", [m.loop("lp", m.block(null, [
          m.if(m.i32.eqz(i()), m.br("done")),
          m.if(m.i32.ne(limb(a(), m.i32.sub(i(), m.i32.const(1))), m.i32.const(0)), m.br("done")),
          m.local.set(1, m.i32.sub(i(), m.i32.const(1))),
          m.br("lp"),
        ]))]),
        m.local.set(2, m.array.new(t.Limbs, i(), m.i32.const(0))),
        m.array.copy(res(), m.i32.const(0), a(), m.i32.const(0), i()),
        res(),
      ], t.LimbsRef);
      m.addFunction("$mag_norm", binaryen.createType([t.LimbsRef]), t.LimbsRef, [I, t.LimbsRef], body);
    }

    // $mag_cmp(a,b) -> i32 (-1/0/1), inputs normalized
    {
      const a = () => m.local.get(0, t.LimbsRef), b = () => m.local.get(1, t.LimbsRef);
      const la = () => m.local.get(2, I), lb = () => m.local.get(3, I), i = () => m.local.get(4, I);
      const body = m.block("ret", [
        m.local.set(2, m.array.len(a())), m.local.set(3, m.array.len(b())),
        m.if(m.i32.ne(la(), lb()),
          m.br("ret", undefined, m.select(m.i32.lt_u(la(), lb()), m.i32.const(-1), m.i32.const(1)))),
        m.local.set(4, la()),
        m.block("done", [m.loop("lp", m.block(null, [
          m.if(m.i32.eqz(i()), m.br("done")),
          m.local.set(4, m.i32.sub(i(), m.i32.const(1))),
          m.if(m.i32.ne(limb(a(), i()), limb(b(), i())),
            m.br("ret", undefined, m.select(m.i32.lt_u(limb(a(), i()), limb(b(), i())), m.i32.const(-1), m.i32.const(1)))),
          m.br("lp"),
        ]))]),
        m.i32.const(0),
      ], I);
      m.addFunction("$mag_cmp", binaryen.createType([t.LimbsRef, t.LimbsRef]), I, [I, I, I], body);
    }

    // $mag_add(a,b) -> limbs
    {
      const a = () => m.local.get(0, t.LimbsRef), b = () => m.local.get(1, t.LimbsRef);
      const la = () => m.local.get(2, I), lb = () => m.local.get(3, I), n = () => m.local.get(4, I);
      const res = () => m.local.get(5, t.LimbsRef), i = () => m.local.get(6, I), carry = () => m.local.get(7, L);
      const s = () => m.local.get(8, L);
      const av = m.if(m.i32.lt_u(i(), la()), ue(limb(a(), i())), m.i64.const(0n), L);
      const bv = m.if(m.i32.lt_u(i(), lb()), ue(limb(b(), i())), m.i64.const(0n), L);
      const body = m.block(null, [
        m.local.set(2, m.array.len(a())), m.local.set(3, m.array.len(b())),
        m.local.set(4, m.i32.add(m.select(m.i32.gt_u(la(), lb()), la(), lb()), m.i32.const(1))),
        m.local.set(5, m.array.new(t.Limbs, n(), m.i32.const(0))),
        m.local.set(6, m.i32.const(0)), m.local.set(7, m.i64.const(0n)),
        m.block("done", [m.loop("lp", m.block(null, [
          m.if(m.i32.ge_u(i(), n()), m.br("done")),
          m.local.set(8, m.i64.add(m.i64.add(carry(), av), bv)),
          m.array.set(res(), i(), m.i32.wrap(s())),
          m.local.set(7, m.i64.shr_u(s(), m.i64.const(32n))),
          m.local.set(6, m.i32.add(i(), m.i32.const(1))),
          m.br("lp"),
        ]))]),
        m.call("$mag_norm", [res()], t.LimbsRef),
      ], t.LimbsRef);
      m.addFunction("$mag_add", binaryen.createType([t.LimbsRef, t.LimbsRef]), t.LimbsRef, [I, I, I, t.LimbsRef, I, L, L], body);
    }

    // $mag_sub(a,b) -> limbs   (requires mag(a) >= mag(b))
    {
      const a = () => m.local.get(0, t.LimbsRef), b = () => m.local.get(1, t.LimbsRef);
      const la = () => m.local.get(2, I), lb = () => m.local.get(3, I);
      const res = () => m.local.get(4, t.LimbsRef), i = () => m.local.get(5, I), borrow = () => m.local.get(6, L);
      const d = () => m.local.get(7, L);
      const bv = m.if(m.i32.lt_u(i(), lb()), ue(limb(b(), i())), m.i64.const(0n), L);
      const body = m.block(null, [
        m.local.set(2, m.array.len(a())), m.local.set(3, m.array.len(b())),
        m.local.set(4, m.array.new(t.Limbs, la(), m.i32.const(0))),
        m.local.set(5, m.i32.const(0)), m.local.set(6, m.i64.const(0n)),
        m.block("done", [m.loop("lp", m.block(null, [
          m.if(m.i32.ge_u(i(), la()), m.br("done")),
          m.local.set(7, m.i64.sub(m.i64.sub(ue(limb(a(), i())), bv), borrow())),
          m.array.set(res(), i(), m.i32.wrap(d())),
          m.local.set(6, m.select(m.i64.lt_s(d(), m.i64.const(0n)), m.i64.const(1n), m.i64.const(0n))),
          m.local.set(5, m.i32.add(i(), m.i32.const(1))),
          m.br("lp"),
        ]))]),
        m.call("$mag_norm", [res()], t.LimbsRef),
      ], t.LimbsRef);
      m.addFunction("$mag_sub", binaryen.createType([t.LimbsRef, t.LimbsRef]), t.LimbsRef, [I, I, t.LimbsRef, I, L, L], body);
    }

    // $mag_mul(a,b) -> limbs
    {
      const a = () => m.local.get(0, t.LimbsRef), b = () => m.local.get(1, t.LimbsRef);
      const la = () => m.local.get(2, I), lb = () => m.local.get(3, I), res = () => m.local.get(4, t.LimbsRef);
      const i = () => m.local.get(5, I), j = () => m.local.get(6, I), carry = () => m.local.get(7, L);
      const ai = () => m.local.get(8, L), cur = () => m.local.get(9, L), k = () => m.local.get(10, I);
      const body = m.block(null, [
        m.local.set(2, m.array.len(a())), m.local.set(3, m.array.len(b())),
        m.local.set(4, m.array.new(t.Limbs, m.i32.add(la(), lb()), m.i32.const(0))),
        m.local.set(5, m.i32.const(0)),
        m.block("iend", [m.loop("ilp", m.block(null, [
          m.if(m.i32.ge_u(i(), la()), m.br("iend")),
          m.local.set(8, ue(limb(a(), i()))),
          m.local.set(7, m.i64.const(0n)),
          m.local.set(6, m.i32.const(0)),
          m.block("jend", [m.loop("jlp", m.block(null, [
            m.if(m.i32.ge_u(j(), lb()), m.br("jend")),
            m.local.set(9, m.i64.add(m.i64.add(ue(limb(res(), m.i32.add(i(), j()))), m.i64.mul(ai(), ue(limb(b(), j())))), carry())),
            m.array.set(res(), m.i32.add(i(), j()), m.i32.wrap(cur())),
            m.local.set(7, m.i64.shr_u(cur(), m.i64.const(32n))),
            m.local.set(6, m.i32.add(j(), m.i32.const(1))),
            m.br("jlp"),
          ]))]),
          // propagate carry into res[i+lb], res[i+lb+1], ...
          m.local.set(10, m.i32.add(i(), lb())),
          m.block("cend", [m.loop("clp", m.block(null, [
            m.if(m.i64.eqz(carry()), m.br("cend")),
            m.local.set(9, m.i64.add(ue(limb(res(), k())), carry())),
            m.array.set(res(), k(), m.i32.wrap(cur())),
            m.local.set(7, m.i64.shr_u(cur(), m.i64.const(32n))),
            m.local.set(10, m.i32.add(k(), m.i32.const(1))),
            m.br("clp"),
          ]))]),
          m.local.set(5, m.i32.add(i(), m.i32.const(1))),
          m.br("ilp"),
        ]))]),
        m.call("$mag_norm", [res()], t.LimbsRef),
      ], t.LimbsRef);
      m.addFunction("$mag_mul", binaryen.createType([t.LimbsRef, t.LimbsRef]), t.LimbsRef, [I, I, t.LimbsRef, I, I, L, L, L, I], body);
    }

    // $mag_divmod_small(limbs, divisor) -> limbs (quotient, normalized);
    // remainder left in global $bn_rem.
    m.addGlobal("$bn_rem", I, true, m.i32.const(0));
    {
      const a = () => m.local.get(0, t.LimbsRef), div = () => m.local.get(1, I);
      const len = () => m.local.get(2, I), q = () => m.local.get(3, t.LimbsRef);
      const rem = () => m.local.get(4, L), i = () => m.local.get(5, I), cur = () => m.local.get(6, L);
      const body = m.block(null, [
        m.local.set(2, m.array.len(a())),
        m.local.set(3, m.array.new(t.Limbs, len(), m.i32.const(0))),
        m.local.set(4, m.i64.const(0n)),
        m.local.set(5, len()),
        m.block("done", [m.loop("lp", m.block(null, [
          m.if(m.i32.eqz(i()), m.br("done")),
          m.local.set(5, m.i32.sub(i(), m.i32.const(1))),
          m.local.set(6, m.i64.or(m.i64.shl(rem(), m.i64.const(32n)), ue(limb(a(), i())))),
          m.array.set(q(), i(), m.i32.wrap(m.i64.div_u(cur(), ue(div())))),
          m.local.set(4, m.i64.rem_u(cur(), ue(div()))),
          m.br("lp"),
        ]))]),
        m.global.set("$bn_rem", m.i32.wrap(rem())),
        m.call("$mag_norm", [q()], t.LimbsRef),
      ], t.LimbsRef);
      m.addFunction("$mag_divmod_small", binaryen.createType([t.LimbsRef, I]), t.LimbsRef, [I, t.LimbsRef, L, I, L], body);
    }

    // ONE magnitude constant [1]
    m.addFunction("$mag_one", binaryen.createType([]), t.LimbsRef, [t.LimbsRef], m.block(null, [
      m.local.set(0, m.array.new(t.Limbs, m.i32.const(1), m.i32.const(1))),
      m.local.get(0, t.LimbsRef),
    ], t.LimbsRef));

    // $mag_bitlen(a) -> i32
    {
      const a = () => m.local.get(0, t.LimbsRef), len = () => m.local.get(1, I);
      const body = m.block("ret", [
        m.local.set(1, m.array.len(a())),
        m.if(m.i32.eqz(len()), m.br("ret", undefined, m.i32.const(0))),
        m.i32.sub(m.i32.mul(len(), m.i32.const(32)), m.i32.clz(limb(a(), m.i32.sub(len(), m.i32.const(1))))),
      ], I);
      m.addFunction("$mag_bitlen", binaryen.createType([t.LimbsRef]), I, [I], body);
    }

    // $mag_bit(a, i) -> 0/1
    {
      const a = () => m.local.get(0, t.LimbsRef), i = () => m.local.get(1, I);
      const li = () => m.i32.shr_u(i(), m.i32.const(5)), bit = () => m.i32.and(i(), m.i32.const(31));
      const body = m.block("ret", [
        m.if(m.i32.ge_u(li(), m.array.len(a())), m.br("ret", undefined, m.i32.const(0))),
        m.i32.and(m.i32.shr_u(limb(a(), li()), bit()), m.i32.const(1)),
      ], I);
      m.addFunction("$mag_bit", binaryen.createType([t.LimbsRef, I]), I, [], body);
    }

    // $mag_divmod(a, b) -> quotient limbs (b != 0); remainder in global $bn_rmag.
    // Binary long division (shift-and-subtract), MSB first.
    const limbsRefN = binaryen.getTypeFromHeapType(t.Limbs, true);
    m.addGlobal("$bn_rmag", limbsRefN, true, m.ref.null(limbsRefN));
    {
      const a = () => m.local.get(0, t.LimbsRef), b = () => m.local.get(1, t.LimbsRef);
      const q = () => m.local.get(2, t.LimbsRef), r = () => m.local.get(3, t.LimbsRef), i = () => m.local.get(4, I);
      const body = m.block(null, [
        m.local.set(2, m.array.new(t.Limbs, m.array.len(a()), m.i32.const(0))), // quotient
        m.local.set(3, m.array.new(t.Limbs, m.i32.const(0), m.i32.const(0))),   // remainder = 0
        m.local.set(4, m.call("$mag_bitlen", [a()], I)),
        m.block("done", [m.loop("lp", m.block(null, [
          m.if(m.i32.eqz(i()), m.br("done")),
          m.local.set(4, m.i32.sub(i(), m.i32.const(1))),
          // r = r*2 (+ bit i of a)
          m.local.set(3, m.call("$mag_add", [r(), r()], t.LimbsRef)),
          m.if(m.call("$mag_bit", [a(), i()], I),
            m.local.set(3, m.call("$mag_add", [r(), m.call("$mag_one", [], t.LimbsRef)], t.LimbsRef))),
          // if r >= b: r -= b; set bit i of q
          m.if(m.i32.ge_s(m.call("$mag_cmp", [r(), b()], I), m.i32.const(0)), m.block(null, [
            m.local.set(3, m.call("$mag_sub", [r(), b()], t.LimbsRef)),
            m.array.set(q(), m.i32.shr_u(i(), m.i32.const(5)),
              m.i32.or(limb(q(), m.i32.shr_u(i(), m.i32.const(5))),
                m.i32.shl(m.i32.const(1), m.i32.and(i(), m.i32.const(31))))),
          ])),
          m.br("lp"),
        ]))]),
        m.global.set("$bn_rmag", m.call("$mag_norm", [r()], t.LimbsRef)),
        m.call("$mag_norm", [q()], t.LimbsRef),
      ], t.LimbsRef);
      m.addFunction("$mag_divmod", binaryen.createType([t.LimbsRef, t.LimbsRef]), t.LimbsRef, [t.LimbsRef, t.LimbsRef, I], body);
    }

    // $mag_gcd(a, b) -> limbs (Euclid)
    {
      const a = () => m.local.get(0, t.LimbsRef), b = () => m.local.get(1, t.LimbsRef), tmp = () => m.local.get(2, t.LimbsRef);
      const body = m.block("ret", [
        m.block("done", [m.loop("lp", m.block(null, [
          m.if(m.i32.eqz(m.array.len(b())), m.br("done")),
          m.drop(m.call("$mag_divmod", [a(), b()], t.LimbsRef)), // discard quotient; remainder -> $bn_rmag
          m.local.set(2, m.ref.cast(m.global.get("$bn_rmag", limbsRefN), t.LimbsRef)),
          m.local.set(0, b()),
          m.local.set(1, tmp()),
          m.br("lp"),
        ]))]),
        a(),
      ], t.LimbsRef);
      m.addFunction("$mag_gcd", binaryen.createType([t.LimbsRef, t.LimbsRef]), t.LimbsRef, [t.LimbsRef], body);
    }

    // $fix_to_limbs(magnitude i64 >= 0) -> limbs
    {
      const mag = () => m.local.get(0, L);
      const lo = m.i32.wrap(mag()), hi = m.i32.wrap(m.i64.shr_u(mag(), m.i64.const(32n)));
      const res = () => m.local.get(1, t.LimbsRef);
      const body = m.block("ret", [
        m.if(m.i64.eqz(mag()), m.br("ret", undefined, m.array.new(t.Limbs, m.i32.const(0), m.i32.const(0)))),
        m.if(m.i64.lt_u(mag(), m.i64.const(0x100000000n)),
          m.block(null, [
            m.local.set(1, m.array.new(t.Limbs, m.i32.const(1), m.i32.const(0))),
            m.array.set(res(), m.i32.const(0), lo),
            m.br("ret", undefined, res()),
          ])),
        m.local.set(1, m.array.new(t.Limbs, m.i32.const(2), m.i32.const(0))),
        m.array.set(res(), m.i32.const(0), lo),
        m.array.set(res(), m.i32.const(1), hi),
        res(),
      ], t.LimbsRef);
      m.addFunction("$fix_to_limbs", binaryen.createType([L]), t.LimbsRef, [t.LimbsRef], body);
    }

    // $int_sign(num) -> i32 (+1/-1); $int_limbs(num) -> magnitude limbs
    {
      const x = () => m.local.get(0, t.NumRef);
      const isBig = () => m.i32.eq(m.struct.get(0, x(), I, false), m.i32.const(NUM_TAG.BIGNUM));
      const fixVal = () => m.struct.get(1, m.ref.cast(x(), t.FixnumRef), L, false);
      m.addFunction("$int_sign", binaryen.createType([t.NumRef]), I, [],
        m.if(isBig(), m.struct.get(1, m.ref.cast(x(), t.BignumRef), I, false),
          m.select(m.i64.lt_s(fixVal(), m.i64.const(0n)), m.i32.const(-1), m.i32.const(1)), I));
      const mag = () => m.select(m.i64.lt_s(fixVal(), m.i64.const(0n)), m.i64.sub(m.i64.const(0n), fixVal()), fixVal());
      m.addFunction("$int_limbs", binaryen.createType([t.NumRef]), t.LimbsRef, [],
        m.if(isBig(), m.struct.get(2, m.ref.cast(x(), t.BignumRef), t.LimbsRef, false),
          m.call("$fix_to_limbs", [mag()], t.LimbsRef), t.LimbsRef));
    }

    // $bn_norm(sign, limbs) -> (ref $Num): demote to Fixnum when it fits i64.
    {
      const sign = () => m.local.get(0, I), limbs = () => m.local.get(1, t.LimbsRef);
      const len = () => m.local.get(2, I), val = () => m.local.get(3, L);
      const body = m.block("ret", [
        m.local.set(1, m.call("$mag_norm", [limbs()], t.LimbsRef)),
        m.local.set(2, m.array.len(limbs())),
        m.if(m.i32.eqz(len()), m.br("ret", undefined, m.call("$make_fix", [m.i64.const(0n)], t.FixnumRef))),
        // fits i64 if len==1, or len==2 with high limb < 0x80000000
        m.if(m.i32.eq(len(), m.i32.const(1)),
          m.block(null, [
            m.local.set(3, ue(limb(limbs(), m.i32.const(0)))),
            m.br("ret", undefined, m.call("$make_fix", [m.call("$signed", [sign(), val()], binaryen.i64)], t.FixnumRef)),
          ])),
        m.if(m.i32.and(m.i32.eq(len(), m.i32.const(2)), m.i32.lt_u(limb(limbs(), m.i32.const(1)), m.i32.const(0x80000000))),
          m.block(null, [
            m.local.set(3, m.i64.or(m.i64.shl(ue(limb(limbs(), m.i32.const(1))), m.i64.const(32n)), ue(limb(limbs(), m.i32.const(0))))),
            m.br("ret", undefined, m.call("$make_fix", [m.call("$signed", [sign(), val()], binaryen.i64)], t.FixnumRef)),
          ])),
        m.struct.new([m.i32.const(NUM_TAG.BIGNUM), sign(), limbs()], t.Bignum),
      ], t.NumRef);
      m.addFunction("$bn_norm", binaryen.createType([I, t.LimbsRef]), t.NumRef, [I, L], body);
    }

    // helper used above: signed value = (sign<0 ? -val : val)
    // (declared as a tiny function so $bn_norm can call m.signed)
    this.buildSignedHelper();

    // $bn_add / $bn_sub / $bn_mul / $bn_cmp over integer $Num operands
    this.buildBnSigned();

    // $bn_render(limbs, sign, addr) -> end addr   (decimal)
    {
      const limbs = () => m.local.get(0, t.LimbsRef);
      const sign = () => m.local.get(1, I), addr = () => m.local.get(2, I);
      const cur = () => m.local.get(3, t.LimbsRef), cursor = () => m.local.get(4, I);
      const start = () => m.local.get(5, I), j = () => m.local.get(6, I);
      const lo = () => m.i32.add(start(), j());
      const hi = () => m.i32.add(start(), m.i32.sub(m.i32.sub(m.i32.sub(cursor(), m.i32.const(1)), start()), j()));
      const tmp = () => m.local.get(7, I);
      const body = m.block(null, [
        m.local.set(4, addr()),
        m.if(m.i32.lt_s(sign(), m.i32.const(0)), m.block(null, [
          m.i32.store8(0, 0, cursor(), m.i32.const(45)),
          m.local.set(4, m.i32.add(cursor(), m.i32.const(1))),
        ])),
        m.local.set(5, cursor()),
        m.local.set(3, limbs()),
        m.loop("dig", m.block(null, [
          m.local.set(3, m.call("$mag_divmod_small", [cur(), m.i32.const(10)], t.LimbsRef)),
          m.i32.store8(0, 0, cursor(), m.i32.add(m.i32.const(48), m.global.get("$bn_rem", I))),
          m.local.set(4, m.i32.add(cursor(), m.i32.const(1))),
          m.br_if("dig", m.i32.ne(m.array.len(cur()), m.i32.const(0))),
        ])),
        // reverse digits in [start, cursor)
        m.local.set(6, m.i32.const(0)),
        m.block("rdone", [m.loop("rlp", m.block(null, [
          m.br_if("rdone", m.i32.ge_s(j(), m.i32.div_s(m.i32.sub(cursor(), start()), m.i32.const(2)))),
          m.local.set(7, m.i32.load8_u(0, 0, lo())),
          m.i32.store8(0, 0, lo(), m.i32.load8_u(0, 0, hi())),
          m.i32.store8(0, 0, hi(), tmp()),
          m.local.set(6, m.i32.add(j(), m.i32.const(1))),
          m.br("rlp"),
        ]))]),
        cursor(),
      ], I);
      m.addFunction("$bn_render", binaryen.createType([t.LimbsRef, I, I]), I, [t.LimbsRef, I, I, I, I], body);
    }
  }

  private buildSignedHelper() {
    // m.signed isn't a real binaryen op; emulate via a function call wrapper.
    // Provide $signed(sign i32, mag i64) -> i64.
    const m = this.m, I = binaryen.i32, L = binaryen.i64;
    m.addFunction("$signed", binaryen.createType([I, L]), L, [],
      m.select(m.i32.lt_s(m.local.get(0, I), m.i32.const(0)),
        m.i64.sub(m.i64.const(0n), m.local.get(1, L)), m.local.get(1, L)));
  }

  private buildBnSigned() {
    const m = this.m, t = this.t, I = binaryen.i32;
    // $bn_cmp(a,b) -> i32 over integer Nums
    {
      const a = () => m.local.get(0, t.NumRef), b = () => m.local.get(1, t.NumRef);
      const sa = () => m.local.get(2, I), sb = () => m.local.get(3, I);
      const body = m.block("ret", [
        m.local.set(2, m.call("$int_sign", [a()], I)),
        m.local.set(3, m.call("$int_sign", [b()], I)),
        // zero handled by caller normally; treat magnitudes
        m.if(m.i32.ne(sa(), sb()), m.br("ret", undefined, m.select(m.i32.lt_s(sa(), sb()), m.i32.const(-1), m.i32.const(1)))),
        m.i32.mul(sa(), m.call("$mag_cmp", [m.call("$int_limbs", [a()], t.LimbsRef), m.call("$int_limbs", [b()], t.LimbsRef)], I)),
      ], I);
      m.addFunction("$bn_cmp", binaryen.createType([t.NumRef, t.NumRef]), I, [I, I], body);
    }
    // $bn_addsub(a, b, subtract i32) -> Num
    {
      const a = () => m.local.get(0, t.NumRef), b = () => m.local.get(1, t.NumRef);
      const sub = () => m.local.get(2, I);
      const sa = () => m.local.get(3, I), sb = () => m.local.get(4, I);
      const ma = () => m.local.get(5, t.LimbsRef), mb = () => m.local.get(6, t.LimbsRef);
      const cmp = () => m.local.get(7, I);
      const body = m.block("ret", [
        m.local.set(3, m.call("$int_sign", [a()], I)),
        m.local.set(4, m.i32.mul(m.call("$int_sign", [b()], I), m.select(sub(), m.i32.const(-1), m.i32.const(1)))),
        m.local.set(5, m.call("$int_limbs", [a()], t.LimbsRef)),
        m.local.set(6, m.call("$int_limbs", [b()], t.LimbsRef)),
        // same sign: add magnitudes, keep sign
        m.if(m.i32.eq(sa(), sb()),
          m.br("ret", undefined, m.call("$bn_norm", [sa(), m.call("$mag_add", [ma(), mb()], t.LimbsRef)], t.NumRef))),
        // different signs: subtract smaller magnitude from larger; sign of larger
        m.local.set(7, m.call("$mag_cmp", [ma(), mb()], I)),
        m.if(m.i32.eqz(cmp()), m.br("ret", undefined, m.call("$make_fix", [m.i64.const(0n)], t.FixnumRef))),
        m.if(m.i32.gt_s(cmp(), m.i32.const(0)),
          m.br("ret", undefined, m.call("$bn_norm", [sa(), m.call("$mag_sub", [ma(), mb()], t.LimbsRef)], t.NumRef))),
        m.call("$bn_norm", [sb(), m.call("$mag_sub", [mb(), ma()], t.LimbsRef)], t.NumRef),
      ], t.NumRef);
      m.addFunction("$bn_addsub", binaryen.createType([t.NumRef, t.NumRef, I]), t.NumRef, [I, I, t.LimbsRef, t.LimbsRef, I], body);
    }
    // $bn_mul(a,b) -> Num
    {
      const a = () => m.local.get(0, t.NumRef), b = () => m.local.get(1, t.NumRef);
      m.addFunction("$bn_mul", binaryen.createType([t.NumRef, t.NumRef]), t.NumRef, [],
        m.call("$bn_norm", [
          m.i32.mul(m.call("$int_sign", [a()], I), m.call("$int_sign", [b()], I)),
          m.call("$mag_mul", [m.call("$int_limbs", [a()], t.LimbsRef), m.call("$int_limbs", [b()], t.LimbsRef)], t.LimbsRef),
        ], t.NumRef));
    }
  }

  private buildArith() {
    for (const op of ["add", "sub", "mul", "divide"] as const) {
      this.buildBinop(op);
    }
  }

  // a,b : (ref $Num) -> (ref $Num).  Dispatch: rough contagious; else exact
  // rational arithmetic over (n/d).
  private buildBinop(op: "add" | "sub" | "mul" | "divide") {
    const m = this.m, t = this.t, L = binaryen.i64, F = binaryen.f64;
    const a = () => m.local.get(0, t.NumRef);
    const b = () => m.local.get(1, t.NumRef);
    const tagA = () => m.struct.get(0, a(), binaryen.i32, false);
    const tagB = () => m.struct.get(0, b(), binaryen.i32, false);
    const eitherRough = m.i32.or(
      m.i32.eq(tagA(), m.i32.const(NUM_TAG.ROUGH)),
      m.i32.eq(tagB(), m.i32.const(NUM_TAG.ROUGH)));
    const isInt = (tag: number) => m.i32.or(m.i32.eq(tag, m.i32.const(NUM_TAG.FIX)), m.i32.eq(tag, m.i32.const(NUM_TAG.BIGNUM)));
    const bothInt = m.i32.and(isInt(tagA()), isInt(tagB()));
    // integer path (arbitrary precision) for add/sub/mul
    let intResult: number | null = null;
    if (op === "add") intResult = m.call("$bn_addsub", [a(), b(), m.i32.const(0)], t.NumRef);
    else if (op === "sub") intResult = m.call("$bn_addsub", [a(), b(), m.i32.const(1)], t.NumRef);
    else if (op === "mul") intResult = m.call("$bn_mul", [a(), b()], t.NumRef);

    // rough path
    const fa = m.call("$to_f64", [a()], F);
    const fb = m.call("$to_f64", [b()], F);
    let roughExpr: number;
    switch (op) {
      case "add": roughExpr = m.f64.add(fa, fb); break;
      case "sub": roughExpr = m.f64.sub(fa, fb); break;
      case "mul": roughExpr = m.f64.mul(fa, fb); break;
      case "divide": roughExpr = m.f64.div(fa, fb); break;
    }
    const roughResult = m.call("$make_rough", [roughExpr], t.RoughnumRef);

    // exact rational path over integer $Num components: na/da op nb/db.
    // locals: 2=na 3=da 4=nb 5=db  (all (ref $Num) integers)
    const na = () => m.local.get(2, t.NumRef);
    const da = () => m.local.get(3, t.NumRef);
    const nb = () => m.local.get(4, t.NumRef);
    const db = () => m.local.get(5, t.NumRef);
    const mul = (x: number, y: number) => m.call("$bn_mul", [x, y], t.NumRef);
    const addsub = (x: number, y: number, sub: number) => m.call("$bn_addsub", [x, y, m.i32.const(sub)], t.NumRef);
    let exactN: number, exactD: number;
    switch (op) {
      case "add": exactN = addsub(mul(na(), db()), mul(nb(), da()), 0); exactD = mul(da(), db()); break;
      case "sub": exactN = addsub(mul(na(), db()), mul(nb(), da()), 1); exactD = mul(da(), db()); break;
      case "mul": exactN = mul(na(), nb()); exactD = mul(da(), db()); break;
      case "divide": exactN = mul(na(), db()); exactD = mul(da(), nb()); break;
    }
    const exactBody = m.block(null, [
      m.local.set(2, this.exactNum(a())),
      m.local.set(3, this.exactDen(a())),
      m.local.set(4, this.exactNum(b())),
      m.local.set(5, this.exactDen(b())),
      m.return(m.call("$make_rat", [exactN, exactD], t.NumRef)),
    ], t.NumRef);

    const nonRough = intResult !== null
      ? m.if(bothInt, intResult, exactBody, t.NumRef)
      : exactBody;
    const body = m.if(eitherRough, roughResult, nonRough, t.NumRef);
    m.addFunction(`$num_${op}`, binaryen.createType([t.NumRef, t.NumRef]), t.NumRef,
      [t.NumRef, t.NumRef, t.NumRef, t.NumRef], body);
    void L;
  }

  private buildNumEqual() {
    const m = this.m, t = this.t, L = binaryen.i64, F = binaryen.f64;
    const a = () => m.local.get(0, t.NumRef);
    const b = () => m.local.get(1, t.NumRef);
    const eitherRough = m.i32.or(
      m.i32.eq(m.struct.get(0, a(), binaryen.i32, false), m.i32.const(NUM_TAG.ROUGH)),
      m.i32.eq(m.struct.get(0, b(), binaryen.i32, false), m.i32.const(NUM_TAG.ROUGH)));
    const roughEq = m.f64.eq(m.call("$to_f64", [a()], F), m.call("$to_f64", [b()], F));
    // exact: cross-multiply na*db == nb*da (over integer $Num components)
    const exactEq = m.i32.eqz(m.call("$bn_cmp", [
      m.call("$bn_mul", [this.exactNum(a()), this.exactDen(b())], t.NumRef),
      m.call("$bn_mul", [this.exactNum(b()), this.exactDen(a())], t.NumRef)], binaryen.i32));
    const bnEq = m.i32.eqz(m.call("$bn_cmp", [a(), b()], binaryen.i32));
    const body = m.if(eitherRough, roughEq,
      m.if(this.bothInt(a, b), bnEq, exactEq, binaryen.i32), binaryen.i32);
    m.addFunction("$num_equal", binaryen.createType([t.NumRef, t.NumRef]), binaryen.i32, [], body);
    void L;
  }

  // returns -1, 0, 1
  private buildNumCompare() {
    const m = this.m, t = this.t, L = binaryen.i64, F = binaryen.f64;
    const a = () => m.local.get(0, t.NumRef);
    const b = () => m.local.get(1, t.NumRef);
    const eitherRough = m.i32.or(
      m.i32.eq(m.struct.get(0, a(), binaryen.i32, false), m.i32.const(NUM_TAG.ROUGH)),
      m.i32.eq(m.struct.get(0, b(), binaryen.i32, false), m.i32.const(NUM_TAG.ROUGH)));
    const fa = m.call("$to_f64", [a()], F), fb = m.call("$to_f64", [b()], F);
    const roughCmp = m.select(m.f64.lt(fa, fb), m.i32.const(-1),
      m.select(m.f64.gt(fa, fb), m.i32.const(1), m.i32.const(0)));
    // exact: compare na*db vs nb*da (db,da>0), over integer $Num components
    const exactCmp = m.call("$bn_cmp", [
      m.call("$bn_mul", [this.exactNum(a()), this.exactDen(b())], t.NumRef),
      m.call("$bn_mul", [this.exactNum(b()), this.exactDen(a())], t.NumRef)], binaryen.i32);
    const bnCmp = m.call("$bn_cmp", [a(), b()], binaryen.i32);
    const body = m.if(eitherRough, roughCmp,
      m.if(this.bothInt(a, b), bnCmp, exactCmp, binaryen.i32), binaryen.i32);
    m.addFunction("$num_compare", binaryen.createType([t.NumRef, t.NumRef]), binaryen.i32, [], body);
    void L;
  }

  // $num_to_string(ref $Num) -> i32 (byte length written at SCRATCH_OFFSET)
  // Handles fixnum (decimal) and rational ("n/d"). Roughnum deferred.
  private buildNumToString() {
    const m = this.m, t = this.t, I = binaryen.i32;
    // $render_num(v, addr) -> end addr. Writes the number's decimal repr at addr.
    {
      const v = () => m.local.get(0, t.NumRef);
      const addr = () => m.local.get(1, I);
      const len = () => m.local.get(2, I);
      const tg = () => m.struct.get(0, v(), I, false);
      const rough = "roughnum";
      const roughStores = Array.from(rough, (ch, i) =>
        m.i32.store8(0, 0, m.i32.add(addr(), m.i32.const(i)), m.i32.const(ch.charCodeAt(0))));
      const body = m.block("ret", [
        m.if(m.i32.eq(tg(), m.i32.const(NUM_TAG.ROUGH)),
          m.block(null, [...roughStores, m.br("ret", undefined, m.i32.add(addr(), m.i32.const(rough.length)))])),
        m.if(m.i32.eq(tg(), m.i32.const(NUM_TAG.BIGNUM)),
          m.br("ret", undefined, m.call("$bn_render", [
            m.struct.get(2, m.ref.cast(v(), t.BignumRef), t.LimbsRef, false),
            m.struct.get(1, m.ref.cast(v(), t.BignumRef), I, false), addr()], I))),
        // rational: render numerator '/' denominator (recursive on $Num components)
        m.if(m.i32.eq(tg(), m.i32.const(NUM_TAG.RATIONAL)), m.block(null, [
          m.local.set(2, m.call("$render_num", [m.struct.get(1, m.ref.cast(v(), t.RationalRef), t.NumRef, false), addr()], I)),
          m.i32.store8(0, 0, len(), m.i32.const(47)), // '/'
          m.br("ret", undefined, m.call("$render_num", [
            m.struct.get(2, m.ref.cast(v(), t.RationalRef), t.NumRef, false),
            m.i32.add(len(), m.i32.const(1))], I)),
        ])),
        // fixnum
        m.br("ret", undefined, m.i32.add(addr(),
          m.call("$write_i64", [m.struct.get(1, m.ref.cast(v(), t.FixnumRef), binaryen.i64, false), addr()], I))),
      ], I);
      m.addFunction("$render_num", binaryen.createType([t.NumRef, I]), I, [I], body);
    }
    // $num_to_string(v) -> length, writing at SCRATCH_OFFSET (used by tests).
    m.addFunction("$num_to_string", binaryen.createType([t.NumRef]), I, [],
      m.i32.sub(m.call("$render_num", [m.local.get(0, t.NumRef), m.i32.const(SCRATCH_OFFSET)], I),
        m.i32.const(SCRATCH_OFFSET)));

    this.buildWriteI64();
  }

  // $write_i64(i64 value, i32 addr) -> i32 bytes written. Writes decimal ASCII.
  private buildWriteI64() {
    const m = this.m, L = binaryen.i64, I = binaryen.i32;
    // params: 0=value(i64) 1=addr(i32)
    // locals: 2=neg 3=startaddr 4=count 5=j 6=tmpLo 7=tmpHi   (all i32)
    const val = () => m.local.get(0, L);
    const addr = () => m.local.get(1, I);
    const neg = () => m.local.get(2, I);
    const start = () => m.local.get(3, I);
    const count = () => m.local.get(4, I);
    const j = () => m.local.get(5, I);
    const c0 = m.i64.const(0n);
    const ten = m.i64.const(10n);

    const lo = () => m.i32.add(start(), j());
    const hi = () => m.i32.add(start(), m.i32.sub(m.i32.sub(count(), m.i32.const(1)), j()));

    const body = m.block("ret", [
      // handle zero
      m.if(m.i64.eqz(val()), m.block(null, [
        m.i32.store8(0, 0, addr(), m.i32.const(48)), // '0'
        m.br("ret", undefined, m.i32.const(1)),
      ])),
      // negative?
      m.if(m.i64.lt_s(val(), c0), m.block(null, [
        m.local.set(2, m.i32.const(1)),
        m.local.set(0, m.i64.sub(c0, val())),
      ])),
      m.local.set(3, m.i32.add(addr(), neg())), // startaddr = addr + neg
      m.local.set(4, m.i32.const(0)),           // count = 0
      // emit digits least-significant first
      m.loop("digits", m.block(null, [
        m.i32.store8(0, 0, m.i32.add(start(), count()),
          m.i32.add(m.i32.const(48), m.i32.wrap(m.i64.rem_u(val(), ten)))),
        m.local.set(0, m.i64.div_u(val(), ten)),
        m.local.set(4, m.i32.add(count(), m.i32.const(1))),
        m.br_if("digits", m.i64.ne(val(), c0)),
      ])),
      // reverse digits in place
      m.local.set(5, m.i32.const(0)),
      m.block("rev_done", [
        m.loop("rev", m.block(null, [
          m.br_if("rev_done", m.i32.ge_s(j(), m.i32.div_s(count(), m.i32.const(2)))),
          m.local.set(6, m.i32.load8_u(0, 0, lo())),
          m.local.set(7, m.i32.load8_u(0, 0, hi())),
          m.i32.store8(0, 0, lo(), m.local.get(7, I)),
          m.i32.store8(0, 0, hi(), m.local.get(6, I)),
          m.local.set(5, m.i32.add(j(), m.i32.const(1))),
          m.br("rev"),
        ])),
      ]),
      // prepend '-' if negative
      m.if(neg(), m.i32.store8(0, 0, addr(), m.i32.const(45))),
      m.br("ret", undefined, m.i32.add(count(), neg())),
    ], I);
    m.addFunction("$write_i64", binaryen.createType([L, I]), I, [I, I, I, I, I, I], body);
  }
}
