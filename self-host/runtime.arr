#lang pyret
# PORT (sketch) of src/compiler/runtime.ts — emits the WASM runtime (number tower,
# value model, strings, variants/objects, equality, rendering, the check harness,
# and the CPS yield/resume primitives) via encoder.arr. compile.arr installs these
# functions into the wasm-module and refers to them by index.
#
# STATUS: faithful 1:1 catalog of the runtime functions runtime.ts emits, grouped as
# there. The COMPUTE LAYER now has real encoder bodies (mirroring runtime.ts): the
# fixnum fast path ($plus, $num_equal, $num_compare, $num_quotient, $num_modulo), the
# value-model accessors/constructors ($make_fix/$make_rough/$make_variant/$variant_id/
# $variant_field/$num_to_i32/$string_length), strings ($str_concat, $str_equal),
# objects/variants ($make_object, $make_method, $obj_get, $obj_equal, $variant_equal,
# $variant_field_by_name [via the $variant_names global]), and structural equality
# ($equal, dispatching str/num/variant/object/i31). The linear-memory RENDERER
# ($render/$render_num/$render_variant/$render_list/$render_tuple/$render_object/
# $val_to_string + $write_i64/$str_copy/$num_to_string), the CHECK HARNESS
# ($check_is/$check_is_not/$check_pred via the $passed/$total globals + host imports),
# $obj_extend, $cons/$empty_list, $str_from_mem, $str_to_codepoints, $num_expt (fixnum),
# and $to_f64 (fixnum+rough) are now implemented (faithful ports of runtime.ts).
# build-runtime() executes and emits 49 functions / ~3KB of body bytes. The assembler
# (wasm-of-pyret.arr) now sets $link_id/$empty_id from List's link/empty variant ids at
# the start of `main`, so the renderer shows [list: ...] and $cons/$empty_list build
# well-formed variants.
# STILL TODO(port): the rational/bignum tower ($make_rat, all $mag_*, the rough/rational
# contagion in $plus/$num_compare/$render_num, and rat/big cases in $to_f64); the CPS
# $yield primitive (NB: runtime.ts has no standalone $yield function — it lives in the
# {stoppable} codegen path); and is-<variant> predicates (in wasm-of-pyret.arr a-data-expr).
# NB: the backend can't yet RUN these end-to-end (the seed flat-namespace collision
# blocks co-importing the backend with ast.arr to drive compile-prog), so byte-level
# correctness is verified by mirroring runtime.ts + clean compile, not execution.

provide *
import encoder as E

# ===== GC type-section layout (must match what compile.arr emits & types.ts) =====
# One type section; canonical order. compile.arr must lay these out in this order.
T-LIMBS    = 0   # (array (mut i32))                       bignum magnitude
T-NUM      = 1   # (struct (field i32))  open base         rec group 1..5
T-FIX      = 2   # (struct i32 i64)            <: $Num
T-RAT      = 3   # (struct i32 (ref $Num) (ref $Num)) <: $Num
T-ROUGH    = 4   # (struct i32 f64)           <: $Num
T-BIG      = 5   # (struct i32 i32 (ref $Limbs)) <: $Num   sign + limbs
T-STR      = 6   # (array (mut i8))
T-FIELDS   = 7   # (array (mut anyref))
T-VARIANT  = 8   # (struct i32 (ref $Str) (ref $Fields))   id, name, fields
T-CLOSURE  = 9   # (struct i32 (ref null $Fields))         fnIndex, caps
T-NAMES    = 10  # (array (ref $Str))
T-OBJECT   = 11  # (struct (ref $Names) (ref $Fields))
T-METHOD   = 12  # (struct (ref $Closure))

# number tags (NUM_TAG in types.ts)
TAG-FIX = 0
TAG-RAT = 1
TAG-ROUGH = 2
TAG-BIG = 3

# ===== global layout (must match wasm-of-pyret.arr's assembler) =====
# A fixed block of runtime globals occupies the LOWEST indices, so both runtime.arr
# (here) and the assembler agree by name. $variant_names + the per-top-level globals
# follow this block. ($link_id/$empty_id are set by main to List's link/empty ids so
# the renderer shows lists as [list: ...]; -1 until then. $passed/$total drive checks.)
GI-LINK-ID = 0
GI-EMPTY-ID = 1
GI-PASSED = 2
GI-TOTAL = 3
NUM-RT-GLOBALS = 4
GI-VARIANT-NAMES = 4    # first global after the runtime block (when variants exist)
GI-VARIANT-METHODS = 5  # (ref null $Fields): per-variant-id methods object, set at each
                        # a-data-expr; consumed by $lookup_method for method dispatch.

# fixed scratch region in linear memory for marshalling strings to the host (runtime.ts).
SCRATCH-OFFSET = 1024

# the 4 fixed runtime globals, in index order, for the assembler to emit.
fun rt-globals() -> List:
  [list:
    E.global-entry(i32t, 1, E.i32-const(0 - 1)),   # $link_id  = -1
    E.global-entry(i32t, 1, E.i32-const(0 - 1)),   # $empty_id = -1
    E.global-entry(i32t, 1, E.i32-const(0)),       # $passed   = 0
    E.global-entry(i32t, 1, E.i32-const(0)) ]      # $total    = 0
end

# value-type byte shorthands
i32t = [list: 127]
i64t = [list: 126]
f64t = [list: 124]
anyref = E.anyref

# A runtime function to emit: name, type signature, locals, body bytes.
data RtFun: rt-fun(name :: String, params :: List<List<Number>>, results :: List<List<Number>>,
                   locals :: List<List<Number>>, body :: List<Number>) end

# placeholder: a trapping body; `note` records the runtime.ts approach for later.
fun todo(name :: String, note :: String) -> RtFun:
  rt-fun(name, empty, empty, empty, E.unreachable.append(E.end-instr))
end

# ===== host imports (provided by src/runtime/run.ts) =====
# These occupy the LOWEST function indices (imports precede defined functions in the
# wasm funcidx space), so EVERY internal `call`/table/export funcidx is offset by
# `num-host-imports`. Names + order + signatures MIRROR src/compiler/runtime.ts's
# buildImports() exactly, so the host object in run.ts resolves them and the offsets
# match the seed. (module is "host" for all.)
data HostImport: host-import(name :: String, params :: List, results :: List) end
host-imports :: List<HostImport> = [list:
  host-import("print",                [list: i32t, i32t], empty),
  host-import("check_stash",          [list: i32t, i32t], empty),
  host-import("check_fail",           [list: i32t, i32t], empty),
  host-import("check_fail_isnot",     [list: i32t, i32t], empty),
  host-import("check_fail_pred",      [list: i32t, i32t], empty),
  host-import("check_summary",        [list: i32t, i32t], empty),
  host-import("raise",                [list: i32t, i32t], empty),
  host-import("check_raises",         [list: i32t, i32t], [list: i32t]),
  host-import("emit_byte",            [list: i32t],       empty),
  host-import("do_pause",             empty,              empty),
  host-import("read_source_into",     [list: i32t],       [list: i32t]),
  host-import("parse_source",         empty,              [list: i32t]),
  host-import("parse_node_tag",       [list: i32t],       [list: i32t]),
  host-import("parse_node_nkids",     [list: i32t],       [list: i32t]),
  host-import("parse_node_str_into",  [list: i32t, i32t], [list: i32t]) ]
num-host-imports :: Number = length(host-imports)
# import funcidx of a host import by name (0-based; imports come first in the space).
fun host-import-index(name :: String) -> Number: hi-index(host-imports, name, 0) end
fun hi-index(hs, name :: String, i :: Number) -> Number:
  cases(List) hs:
    | empty => raise("runtime: no host import named " + name)
    | link(f, r) => if f.name == name: i else: hi-index(r, name, i + 1) end
  end
end
# func index of runtime fn at runtime-list position `pos` (after the import block).
fun rt-funcidx-at(pos :: Number) -> Number: num-host-imports + pos end
# name -> runtime-list position (over all-runtime-funs, defined below) -> a `call`.
fun rt-pos(name :: String) -> Number: rtp(all-runtime-funs, name, 0) end
fun rtp(xs, name :: String, i :: Number) -> Number:
  cases(List) xs:
    | empty => raise("runtime: no runtime fn named " + name)
    | link(f, r) => if f == name: i else: rtp(r, name, i + 1) end
  end
end
fun rt-call(name :: String) -> List<Number>: E.i-call(rt-funcidx-at(rt-pos(name))) end
# call the host `raise` import with an empty message span, then trap (used by the
# value-model lookups when a field/branch is missing). Stack-polymorphic after.
fun raise-host() -> List<Number>:
  E.i32-const(0).append(E.i32-const(0)).append(E.i-call(host-import-index("raise"))).append(E.i-unreachable)
end

# ===== control-flow + body-building helpers (byte lists) =====
# blocktypes: bt-empty (no result); a valtype byte-list = a single-result block.
fun seq(parts :: List) -> List<Number>: E.concat-bytes(parts) end
fun blk(bt, parts :: List) -> List<Number>: E.i-block(bt).append(seq(parts)).append(E.i-end) end
fun lp(parts :: List) -> List<Number>: E.i-loop(E.bt-empty).append(seq(parts)).append(E.i-end) end
fun iff(parts :: List) -> List<Number>: E.i-if(E.bt-empty).append(seq(parts)).append(E.i-end) end
fun iff-bt(bt, parts :: List) -> List<Number>: E.i-if(bt).append(seq(parts)).append(E.i-end) end
fun ifel-bt(bt, tparts :: List, eparts :: List) -> List<Number>:
  E.i-if(bt).append(seq(tparts)).append(E.i-else).append(seq(eparts)).append(E.i-end)
end
# read a fixnum local's i64 payload: (cast $Fixnum).field1
fun fix-i64(idx :: Number) -> List<Number>:
  E.local-get(idx).append(E.ref-cast(T-FIX)).append(E.struct-get(T-FIX, 1))
end
# build a $Str literal value on the stack: array.new_fixed $Str of each ASCII byte.
fun str-lit(s :: String) -> List<Number>:
  codes = string-to-code-points(s)
  E.concat-bytes(codes.map(lam(c): E.i32-const(c) end)).append(E.array-new-fixed(T-STR, length(codes)))
end
# emit i32.store8 of each ASCII byte of `s` at (local[addr-idx] + offset). Used by the
# renderer to splat fixed literals (true/false/nothing/roughnum/"[list: ") into scratch.
fun lit-at(addr-idx :: Number, s :: String) -> List<Number>:
  codes = string-to-code-points(s)
  E.concat-bytes(map2(lam(c, i):
    E.local-get(addr-idx).append(E.i32-const(i)).append(E.i32-add).append(E.i32-const(c)).append(E.i32-store8)
  end, codes, range(0, length(codes))))
end

# ===== number tower: construction =====
# $make_fix(i64) -> (ref $Num) : struct.new $Fixnum {TAG-FIX, i64}
fun emit-make-fix() -> RtFun:
  body = E.i32-const(TAG-FIX)
    .append(E.local-get(0))                 # the i64 arg
    .append(E.struct-new(T-FIX))
    .append(E.end-instr)
  rt-fun("$make_fix", [list: i64t], [list: E.reft(T-NUM)], empty, body)
end

# $make_rough(f64) -> (ref $Num) : struct.new $Roughnum {TAG-ROUGH, f64}
fun emit-make-rough() -> RtFun:
  body = E.i32-const(TAG-ROUGH)
    .append(E.local-get(0))
    .append(E.struct-new(T-ROUGH))
    .append(E.end-instr)
  rt-fun("$make_rough", [list: f64t], [list: E.reft(T-NUM)], empty, body)
end

# $make_rat(num :: $Num, den :: $Num) -> $Num : gcd-reduce then struct.new $Rational
fun emit-make-rat() -> RtFun:
  todo("$make_rat", "reduce num/den via $gcd, normalize sign, struct.new $Rational {TAG-RAT,num,den}")
end

# ===== number tower: ops (FIXNUM fast path; rough/rational/bignum still TODO) =====
# $plus(a, b) -> anyref : string concat if a is a $Str, else fixnum add. (mirrors
# runtime.ts $plus, fixnum-only arithmetic — TODO(port): num-tower contagion.)
fun emit-plus() -> RtFun:
  body = E.local-get(0).append(E.ref-test-null(T-STR))
    .append(ifel-bt(anyref,
        [list: E.local-get(0), E.ref-cast(T-STR), E.local-get(1), E.ref-cast(T-STR), rt-call("$str_concat")],
        [list: fix-i64(0), fix-i64(1), E.i64-add, rt-call("$make_fix")]))
    .append(E.end-instr)
  rt-fun("$plus", [list: anyref, anyref], [list: anyref], empty, body)
end
# $minus(a, b) -> anyref : fixnum subtraction. TODO(port): num-tower contagion.
fun emit-minus() -> RtFun:
  body = fix-i64(0).append(fix-i64(1)).append(E.i64-sub).append(rt-call("$make_fix"))
    .append(E.end-instr)
  rt-fun("$minus", [list: anyref, anyref], [list: anyref], empty, body)
end
# $times(a, b) -> anyref : fixnum multiplication. TODO(port): num-tower contagion.
fun emit-times() -> RtFun:
  body = fix-i64(0).append(fix-i64(1)).append(E.i64-mul).append(rt-call("$make_fix"))
    .append(E.end-instr)
  rt-fun("$times", [list: anyref, anyref], [list: anyref], empty, body)
end
# $divide(a, b) -> anyref : fixnum division. TODO(port): rationals, zero check.
fun emit-divide() -> RtFun:
  body = fix-i64(0).append(fix-i64(1)).append(E.i64-div-s).append(rt-call("$make_fix"))
    .append(E.end-instr)
  rt-fun("$divide", [list: anyref, anyref], [list: anyref], empty, body)
end
# $lessthan(a, b) -> anyref (Pyret bool i31): fixnum <. TODO(port): num-tower.
fun emit-lessthan() -> RtFun:
  body = fix-i64(0).append(fix-i64(1)).append(E.i64-lt-s).append(E.ref-i31)
    .append(E.end-instr)
  rt-fun("$lessthan", [list: anyref, anyref], [list: anyref], empty, body)
end
# $greaterthan(a, b) -> anyref (Pyret bool i31): fixnum >. TODO(port): num-tower.
fun emit-greaterthan() -> RtFun:
  body = fix-i64(0).append(fix-i64(1)).append(E.i64-gt-s).append(E.ref-i31)
    .append(E.end-instr)
  rt-fun("$greaterthan", [list: anyref, anyref], [list: anyref], empty, body)
end
# $lessequal(a, b) -> anyref (Pyret bool i31): fixnum <=. TODO(port): num-tower.
fun emit-lessequal() -> RtFun:
  body = fix-i64(0).append(fix-i64(1)).append(E.i64-le-s).append(E.ref-i31)
    .append(E.end-instr)
  rt-fun("$lessequal", [list: anyref, anyref], [list: anyref], empty, body)
end
# $greaterequal(a, b) -> anyref (Pyret bool i31): fixnum >=. TODO(port): num-tower.
fun emit-greaterequal() -> RtFun:
  body = fix-i64(0).append(fix-i64(1)).append(E.i64-ge-s).append(E.ref-i31)
    .append(E.end-instr)
  rt-fun("$greaterequal", [list: anyref, anyref], [list: anyref], empty, body)
end
# $equal_wrap(a, b) -> anyref (Pyret bool i31): structural equality, wrapped as bool.
# (equals-always and equal-now both dispatch here; same structural comparison.)
fun emit-equal-wrap() -> RtFun:
  body = E.local-get(0).append(E.local-get(1)).append(rt-call("$equal")).append(E.ref-i31)
    .append(E.end-instr)
  rt-fun("$equal_wrap", [list: anyref, anyref], [list: anyref], empty, body)
end
# $num_equal(a, b) -> i32 : fixnum i64 equality. TODO(port): rationals/rough/bignum.
fun emit-num-equal() -> RtFun:
  body = fix-i64(0).append(fix-i64(1)).append(E.i64-eq).append(E.end-instr)
  rt-fun("$num_equal", [list: E.reft(T-NUM), E.reft(T-NUM)], [list: i32t], empty, body)
end
# $num_compare(a, b) -> i32 (-1/0/1) : fixnum i64 compare.
fun emit-num-compare() -> RtFun:
  body = fix-i64(0).append(fix-i64(1)).append(E.i64-lt-s)
    .append(ifel-bt(i32t, [list: E.i32-const(0 - 1)],
        [list: fix-i64(0), fix-i64(1), E.i64-gt-s,
               ifel-bt(i32t, [list: E.i32-const(1)], [list: E.i32-const(0)])]))
    .append(E.end-instr)
  rt-fun("$num_compare", [list: E.reft(T-NUM), E.reft(T-NUM)], [list: i32t], empty, body)
end
# floor div/modulo, fixnum range (mirrors runtime.ts buildIntOps). locals: a=2,b=3,q=4,r=5 (i64)
fun signs-differ() -> List<Number>:
  E.local-get(5).append(E.i64-const(0)).append(E.i64-lt-s)
    .append(E.local-get(3)).append(E.i64-const(0)).append(E.i64-lt-s).append(E.i32-ne)
end
fun r-nonzero() -> List<Number>: E.local-get(5).append(E.i64-eqz).append(E.i32-eqz) end
fun emit-num-quotient() -> RtFun:
  body = seq([list:
      fix-i64(0), E.local-set(2), fix-i64(1), E.local-set(3),
      E.local-get(2), E.local-get(3), E.i64-div-s, E.local-set(4),
      E.local-get(2), E.local-get(3), E.i64-rem-s, E.local-set(5),
      r-nonzero(), signs-differ(), E.i32-and,
      iff([list: E.local-get(4), E.i64-const(1), E.i64-sub, E.local-set(4)]),
      E.local-get(4), rt-call("$make_fix"), E.end-instr ])
  rt-fun("$num_quotient", [list: E.reft(T-NUM), E.reft(T-NUM)], [list: E.reft(T-NUM)],
         [list: E.local-decl(4, i64t)], body)
end
fun emit-num-modulo() -> RtFun:
  body = seq([list:
      fix-i64(0), E.local-set(2), fix-i64(1), E.local-set(3),
      E.local-get(2), E.local-get(3), E.i64-rem-s, E.local-set(5),
      r-nonzero(), signs-differ(), E.i32-and,
      iff([list: E.local-get(5), E.local-get(3), E.i64-add, E.local-set(5)]),
      E.local-get(5), rt-call("$make_fix"), E.end-instr ])
  rt-fun("$num_modulo", [list: E.reft(T-NUM), E.reft(T-NUM)], [list: E.reft(T-NUM)],
         [list: E.local-decl(4, i64t)], body)
end
# $num_expt(base, exp) = base^exp for a non-negative integer exp. runtime.ts loops over
# $num_mul (full tower); since the fixnum fast path has no $num_mul, we inline an i64
# fixnum multiply here (DEVIATION(port): fixnum-only, no tower contagion). locals:
# result=2 (ref $Num), e=3 (i32), i=4 (i32).
fun emit-num-expt() -> RtFun:
  body = blk(E.reft(T-NUM), [list:
      E.local-get(1), rt-call("$num_to_i32"), E.local-set(3),
      E.i64-const(1), rt-call("$make_fix"), E.local-set(2),
      E.i32-const(0), E.local-set(4),
      blk(E.bt-empty, [list:
        lp([list:
          E.local-get(4), E.local-get(3), E.i32-ge-s, iff([list: E.i-br(2)]),
          fix-i64(2), fix-i64(0), E.i64-mul, rt-call("$make_fix"), E.local-set(2),
          E.local-get(4), E.i32-const(1), E.i32-add, E.local-set(4),
          E.i-br(0) ]) ]),
      E.local-get(2) ]).append(E.end-instr)
  rt-fun("$num_expt", [list: E.reft(T-NUM), E.reft(T-NUM)], [list: E.reft(T-NUM)],
         [list: E.local-decl(1, E.reft(T-NUM)), E.local-decl(2, i32t)], body)
end

# $num_to_i32(($Num)) -> i32 : assume fixnum, read i64 field, wrap to i32
fun emit-num-to-i32() -> RtFun:
  body = E.local-get(0)
    .append(E.ref-cast(T-FIX))
    .append(E.struct-get(T-FIX, 1))   # the i64
    .append([list: 167])              # i32.wrap_i64
    .append(E.end-instr)
  rt-fun("$num_to_i32", [list: anyref], [list: i32t], empty, body)
end

# $to_f64(x :: $Num) -> f64 : rough -> the f64 field; else (fixnum) -> convert the i64
# payload. TODO(port): rational (num/den) + bignum (limbs) cases — need $int_to_f64.
fun emit-to-f64() -> RtFun:
  body = E.local-get(0).append(E.struct-get(T-NUM, 0)).append(E.i32-const(TAG-ROUGH)).append(E.i32-eq)
    .append(ifel-bt(f64t,
        [list: E.local-get(0), E.ref-cast(T-ROUGH), E.struct-get(T-ROUGH, 1)],
        [list: E.local-get(0), E.ref-cast(T-FIX), E.struct-get(T-FIX, 1), E.f64-convert-i64-s]))
    .append(E.end-instr)
  rt-fun("$to_f64", [list: E.reft(T-NUM)], [list: f64t], empty, body)
end
# $render_num(v :: $Num, addr :: i32) -> i32 end-addr. Roughnums print "roughnum";
# everything else uses the fixnum decimal path (the tower is fixnum-only). locals: none.
fun emit-render-num() -> RtFun:
  body = blk(i32t, [list:
      E.local-get(0), E.struct-get(T-NUM, 0), E.i32-const(TAG-ROUGH), E.i32-eq, iff([list:
        lit-at(1, "roughnum"),
        E.local-get(1), E.i32-const(8), E.i32-add, E.i-br(1) ]),
      # fixnum: addr + $write_i64((cast $Fixnum).payload, addr)
      E.local-get(1),
      E.local-get(0), E.ref-cast(T-FIX), E.struct-get(T-FIX, 1), E.local-get(1), rt-call("$write_i64"),
      E.i32-add ]).append(E.end-instr)
  rt-fun("$render_num", [list: E.reft(T-NUM), i32t], [list: i32t], empty, body)
end
# $num_to_string(v) -> i32 length written at SCRATCH-OFFSET.
fun emit-num-to-string() -> RtFun:
  body = E.local-get(0).append(E.i32-const(SCRATCH-OFFSET)).append(rt-call("$render_num"))
    .append(E.i32-const(SCRATCH-OFFSET)).append(E.i32-sub).append(E.end-instr)
  rt-fun("$num_to_string", [list: E.reft(T-NUM)], [list: i32t], empty, body)
end
# $write_i64(value :: i64, addr :: i32) -> i32 bytes written (decimal ASCII, in place).
# locals: neg=2,start=3,count=4,j=5,tmpLo=6,tmpHi=7 (all i32).
fun emit-write-i64() -> RtFun:
  body = blk(i32t, [list:
      # zero
      E.local-get(0), E.i64-eqz, iff([list:
        E.local-get(1), E.i32-const(48), E.i32-store8, E.i32-const(1), E.i-br(1) ]),
      # negative -> remember + negate
      E.local-get(0), E.i64-const(0), E.i64-lt-s, iff([list:
        E.i32-const(1), E.local-set(2),
        E.i64-const(0), E.local-get(0), E.i64-sub, E.local-set(0) ]),
      E.local-get(1), E.local-get(2), E.i32-add, E.local-set(3),   # start = addr + neg
      E.i32-const(0), E.local-set(4),                              # count = 0
      # emit digits least-significant-first
      lp([list:
        E.local-get(3), E.local-get(4), E.i32-add,
        E.i32-const(48), E.local-get(0), E.i64-const(10), E.i64-rem-u, E.i32-wrap-i64, E.i32-add,
        E.i32-store8,
        E.local-get(0), E.i64-const(10), E.i64-div-u, E.local-set(0),
        E.local-get(4), E.i32-const(1), E.i32-add, E.local-set(4),
        E.local-get(0), E.i64-const(0), E.i64-ne, E.i-br-if(0) ]),
      # reverse digits in place
      E.i32-const(0), E.local-set(5),
      blk(E.bt-empty, [list:
        lp([list:
          E.local-get(5), E.local-get(4), E.i32-const(2), E.i32-div-s, E.i32-ge-s, E.i-br-if(1),
          E.local-get(3), E.local-get(5), E.i32-add, E.i32-load8-u, E.local-set(6),
          E.local-get(3), E.local-get(4), E.i32-const(1), E.i32-sub, E.local-get(5), E.i32-sub, E.i32-add, E.i32-load8-u, E.local-set(7),
          E.local-get(3), E.local-get(5), E.i32-add, E.local-get(7), E.i32-store8,
          E.local-get(3), E.local-get(4), E.i32-const(1), E.i32-sub, E.local-get(5), E.i32-sub, E.i32-add, E.local-get(6), E.i32-store8,
          E.local-get(5), E.i32-const(1), E.i32-add, E.local-set(5),
          E.i-br(0) ]) ]),
      # prepend '-' if negative
      E.local-get(2), iff([list: E.local-get(1), E.i32-const(45), E.i32-store8 ]),
      E.local-get(4), E.local-get(2), E.i32-add ]).append(E.end-instr)
  rt-fun("$write_i64", [list: i64t, i32t], [list: i32t], [list: E.local-decl(6, i32t)], body)
end

# ===== bignum kernels — magnitude = (array (mut i32)) limbs =====
fun emit-mag-add() -> RtFun: todo("$mag_add", "ripple-carry add of two i32-limb arrays -> normalized array") end
fun emit-mag-sub() -> RtFun: todo("$mag_sub", "borrow subtract (a>=b) -> normalized array") end
fun emit-mag-mul() -> RtFun: todo("$mag_mul", "schoolbook limb*limb (i64 partial products) -> array") end
fun emit-mag-cmp() -> RtFun: todo("$mag_cmp", "MSB-down length then limb compare -> -1/0/1") end
fun emit-mag-divmod() -> RtFun: todo("$mag_divmod", "binary long division over limbs (MSB-down bit loop) -> {quot; rem}") end
fun emit-mag-gcd() -> RtFun: todo("$mag_gcd", "Euclid loop using $mag_divmod") end

# ===== strings ($Str = (array (mut i8))) =====
# $string_length(($Str)) -> $Num(fix) : array.len then make_fix
fun emit-string-length() -> RtFun:
  body = E.local-get(0)
    .append(E.ref-cast(T-STR))
    .append(E.array-len)
    .append([list: 173])              # i64.extend_i32_u
    .append(E.call(rt-funcidx-at(0))) # $make_fix (runtime pos 0, + import offset)
    .append(E.end-instr)
  rt-fun("$string_length", [list: anyref], [list: E.reft(T-NUM)], empty, body)
end
# $str_concat(a, b) -> $Str : new $Str of len(a)+len(b), array.copy a then b.
# locals: la=2, lb=3 (i32); res=4 (ref $Str).
fun emit-str-concat() -> RtFun:
  body = seq([list:
      E.local-get(0), E.array-len, E.local-set(2),
      E.local-get(1), E.array-len, E.local-set(3),
      E.i32-const(0), E.local-get(2), E.local-get(3), E.i32-add, E.array-new(T-STR), E.local-set(4),
      # array.copy res[0..la) <- a[0..la)
      E.local-get(4), E.i32-const(0), E.local-get(0), E.i32-const(0), E.local-get(2), E.array-copy(T-STR, T-STR),
      # array.copy res[la..la+lb) <- b[0..lb)
      E.local-get(4), E.local-get(2), E.local-get(1), E.i32-const(0), E.local-get(3), E.array-copy(T-STR, T-STR),
      E.local-get(4), E.end-instr ])
  rt-fun("$str_concat", [list: E.reft(T-STR), E.reft(T-STR)], [list: E.reft(T-STR)],
         [list: E.local-decl(2, i32t), E.local-decl(1, E.reft(T-STR))], body)
end
# $str_equal(a, b) -> i32 : length check then byte loop. locals: la=2, i=3 (i32).
fun emit-str-equal() -> RtFun:
  body = blk(i32t, [list:
      E.local-get(0), E.array-len, E.local-set(2),
      E.local-get(2), E.local-get(1), E.array-len, E.i32-ne,
      iff([list: E.i32-const(0), E.i-br(1)]),            # lengths differ -> 0
      E.i32-const(0), E.local-set(3),
      blk(E.bt-empty, [list:
        lp([list:
          E.local-get(3), E.local-get(2), E.i32-ge-s, iff([list: E.i-br(2)]),   # i>=la -> done
          E.local-get(0), E.local-get(3), E.array-get-u(T-STR),
          E.local-get(1), E.local-get(3), E.array-get-u(T-STR), E.i32-ne,
          iff([list: E.i32-const(0), E.i-br(3)]),        # bytes differ -> 0
          E.local-get(3), E.i32-const(1), E.i32-add, E.local-set(3),
          E.i-br(0) ]) ]),
      E.i32-const(1) ]).append(E.end-instr)
  rt-fun("$str_equal", [list: E.reft(T-STR), E.reft(T-STR)], [list: i32t],
         [list: E.local-decl(2, i32t)], body)
end
# $str_from_mem(addr, len) -> ref $Str : copy `len` linear-memory bytes from `addr`
# into a fresh $Str. locals: i=2(i32), res=3(ref $Str).
fun emit-str-from-mem() -> RtFun:
  body = blk(E.reft(T-STR), [list:
      E.i32-const(0), E.local-get(1), E.array-new(T-STR), E.local-set(3),
      E.i32-const(0), E.local-set(2),
      blk(E.bt-empty, [list:
        lp([list:
          E.local-get(2), E.local-get(1), E.i32-ge-s, iff([list: E.i-br(2)]),
          E.local-get(3), E.local-get(2),
          E.local-get(0), E.local-get(2), E.i32-add, E.i32-load8-u,
          E.array-set(T-STR),
          E.local-get(2), E.i32-const(1), E.i32-add, E.local-set(2),
          E.i-br(0) ]) ]),
      E.local-get(3) ]).append(E.end-instr)
  rt-fun("$str_from_mem", [list: i32t, i32t], [list: E.reft(T-STR)],
         [list: E.local-decl(1, i32t), E.local-decl(1, E.reft(T-STR))], body)
end
# $str_copy(s, addr) -> i32 length : copy s's bytes into memory at `addr`; return length.
# locals: i=2(i32), len=3(i32).
fun emit-str-copy() -> RtFun:
  body = blk(i32t, [list:
      E.local-get(0), E.array-len, E.local-set(3),
      E.i32-const(0), E.local-set(2),
      blk(E.bt-empty, [list:
        lp([list:
          E.local-get(2), E.local-get(3), E.i32-ge-s, iff([list: E.i-br(2)]),
          E.local-get(1), E.local-get(2), E.i32-add,
          E.local-get(0), E.local-get(2), E.array-get-u(T-STR),
          E.i32-store8,
          E.local-get(2), E.i32-const(1), E.i32-add, E.local-set(2),
          E.i-br(0) ]) ]),
      E.local-get(3) ]).append(E.end-instr)
  rt-fun("$str_copy", [list: E.reft(T-STR), i32t], [list: i32t], [list: E.local-decl(2, i32t)], body)
end
# $str_to_codepoints(s :: $Str) -> anyref (List<Number>) : build from the END so order
# holds (acc = empty; for i = len-1 downto 0: acc = cons(make_fix(s[i]), acc)). Faithful
# port of runtime.ts. locals: i=1 (i32), acc=2 (anyref).
fun emit-str-to-codepoints() -> RtFun:
  body = blk(anyref, [list:
      rt-call("$empty_list"), E.local-set(2),
      E.local-get(0), E.array-len, E.i32-const(1), E.i32-sub, E.local-set(1),
      blk(E.bt-empty, [list:
        lp([list:
          E.local-get(1), E.i32-const(0), E.i32-lt-s, iff([list: E.i-br(2)]),
          E.local-get(0), E.local-get(1), E.array-get-u(T-STR), E.i64-extend-u-i32, rt-call("$make_fix"),
          E.local-get(2), rt-call("$cons"), E.local-set(2),
          E.local-get(1), E.i32-const(1), E.i32-sub, E.local-set(1),
          E.i-br(0) ]) ]),
      E.local-get(2) ]).append(E.end-instr)
  rt-fun("$str_to_codepoints", [list: E.reft(T-STR)], [list: anyref],
         [list: E.local-decl(1, i32t), E.local-decl(1, anyref)], body)
end

# ===== variants / objects / closures =====
# $make_variant(id :: i32, name :: $Str, fields :: $Fields) -> (ref $Variant)
fun emit-make-variant() -> RtFun:
  body = E.local-get(0).append(E.local-get(1)).append(E.local-get(2))
    .append(E.struct-new(T-VARIANT))
    .append(E.end-instr)
  rt-fun("$make_variant", [list: i32t, E.reft(T-STR), E.reft(T-FIELDS)],
         [list: E.reft(T-VARIANT)], empty, body)
end
# $variant_id(anyref) -> i32 : (cast $Variant).field0
fun emit-variant-id() -> RtFun:
  body = E.local-get(0).append(E.ref-cast(T-VARIANT)).append(E.struct-get(T-VARIANT, 0)).append(E.end-instr)
  rt-fun("$variant_id", [list: anyref], [list: i32t], empty, body)
end
# $variant_field(v :: anyref, i :: i32) -> anyref : (cast $Variant).fields[i]
fun emit-variant-field() -> RtFun:
  body = E.local-get(0).append(E.ref-cast(T-VARIANT)).append(E.struct-get(T-VARIANT, 2))
    .append(E.local-get(1)).append(E.array-get(T-FIELDS)).append(E.end-instr)
  rt-fun("$variant_field", [list: anyref, i32t], [list: anyref], empty, body)
end
# $variant_field_by_name(v :: anyref, name :: $Str) -> anyref. Look up v's id, index
# the $variant_names global (global 0: (ref $Fields) of $Names by id) to get this
# variant's field names, scan for `name`, return $variant_field at the match index.
# locals: id=2, n=4, i=5 (i32); names=3 (ref $Names).
fun emit-variant-field-by-name() -> RtFun:
  body = blk(anyref, [list:
      E.local-get(0), E.ref-cast(T-VARIANT), E.struct-get(T-VARIANT, 0), E.local-set(2),  # id
      E.global-get(GI-VARIANT-NAMES), E.local-get(2), E.array-get(T-FIELDS), E.ref-cast(T-NAMES), E.local-set(3),
      E.local-get(3), E.array-len, E.local-set(4),
      E.i32-const(0), E.local-set(5),
      blk(E.bt-empty, [list:
        lp([list:
          E.local-get(5), E.local-get(4), E.i32-ge-s, iff([list: E.i-br(2)]),
          E.local-get(3), E.local-get(5), E.array-get(T-NAMES), E.local-get(1), rt-call("$str_equal"),
          iff([list:
            E.local-get(0), E.ref-cast(T-VARIANT), E.struct-get(T-VARIANT, 2),
            E.local-get(5), E.array-get(T-FIELDS), E.i-br(3) ]),
          E.local-get(5), E.i32-const(1), E.i32-add, E.local-set(5),
          E.i-br(0) ]) ]),
      raise-host() ]).append(E.end-instr)
  rt-fun("$variant_field_by_name", [list: anyref, E.reft(T-STR)], [list: anyref],
         # locals (after params 0,1): 2=id(i32), 3=names(ref $Names), 4=n(i32), 5=i(i32)
         [list: E.local-decl(1, i32t), E.local-decl(1, E.reft(T-NAMES)), E.local-decl(2, i32t)], body)
end
# $variant_equal(a, b) -> i32 : same id and field-wise $equal. locals: n=4, i=5 (i32);
# fa=2, fb=3 (ref null $Fields).
fun emit-variant-equal() -> RtFun:
  body = blk(i32t, [list:
      E.local-get(0), E.struct-get(T-VARIANT, 0), E.local-get(1), E.struct-get(T-VARIANT, 0), E.i32-ne,
      iff([list: E.i32-const(0), E.i-br(1)]),                  # ids differ -> 0
      E.local-get(0), E.struct-get(T-VARIANT, 2), E.local-set(2),
      E.local-get(1), E.struct-get(T-VARIANT, 2), E.local-set(3),
      E.local-get(2), E.ref-is-null, iff([list: E.i32-const(1), E.i-br(1)]),   # both nullary, same id
      E.local-get(2), E.array-len, E.local-set(4),
      E.i32-const(0), E.local-set(5),
      blk(E.bt-empty, [list:
        lp([list:
          E.local-get(5), E.local-get(4), E.i32-ge-s, iff([list: E.i-br(2)]),
          E.local-get(2), E.local-get(5), E.array-get(T-FIELDS),
          E.local-get(3), E.local-get(5), E.array-get(T-FIELDS), rt-call("$equal"), E.i32-eqz,
          iff([list: E.i32-const(0), E.i-br(3)]),
          E.local-get(5), E.i32-const(1), E.i32-add, E.local-set(5),
          E.i-br(0) ]) ]),
      E.i32-const(1) ]).append(E.end-instr)
  rt-fun("$variant_equal", [list: E.reft(T-VARIANT), E.reft(T-VARIANT)], [list: i32t],
         # locals: 2=fields-a, 3=fields-b (ref null $Fields); 4=n, 5=i (i32)
         [list: E.local-decl(2, E.reftnull(T-FIELDS)), E.local-decl(2, i32t)], body)
end
# $make_object(names, values) -> $Object
fun emit-make-object() -> RtFun:
  body = E.local-get(0).append(E.local-get(1)).append(E.struct-new(T-OBJECT)).append(E.end-instr)
  rt-fun("$make_object", [list: E.reft(T-NAMES), E.reft(T-FIELDS)], [list: E.reft(T-OBJECT)], empty, body)
end
# $obj_get(obj :: anyref, name :: $Str) -> anyref : first-match name scan -> value.
# Returns null if obj is not a proper $Object — needed so checker bootstrap expression
# (builtins.current-checker.results()) doesn't trap when builtins is not yet wired.
# locals: i=3, n=4 (i32); names=2 (ref $Names).
fun emit-obj-get() -> RtFun:
  # Inner scan body: assumes obj is a non-null $Object. Returns field or raises.
  inner = blk(anyref, [list:
      E.local-get(0), E.ref-cast(T-OBJECT), E.struct-get(T-OBJECT, 0), E.local-set(2),
      E.local-get(2), E.array-len, E.local-set(4),
      E.i32-const(0), E.local-set(3),
      blk(E.bt-empty, [list:
        lp([list:
          E.local-get(3), E.local-get(4), E.i32-ge-s, iff([list: E.i-br(2)]),
          E.local-get(2), E.local-get(3), E.array-get(T-NAMES), E.local-get(1), rt-call("$str_equal"),
          iff([list:
            E.local-get(0), E.ref-cast(T-OBJECT), E.struct-get(T-OBJECT, 1),
            E.local-get(3), E.array-get(T-FIELDS), E.i-br(3) ]),
          E.local-get(3), E.i32-const(1), E.i32-add, E.local-set(3),
          E.i-br(0) ]) ]),
      raise-host() ])
  # Null-safe outer: if obj is not a non-null $Object, skip to null return.
  # Note: ifel-bt expects tparts/eparts as List<List<Number>> (each element is a byte
  # sequence); wrap `inner` (a flat List<Number>) in [list: inner].
  body = ifel-bt(anyref,
    [list: inner],
    [list: E.i-ref-null(110)])
  .append(E.end-instr)
  # The test: ref.test (non-null $Object) returns 1 if non-null $Object.
  full-body = E.local-get(0).append(E.ref-test(T-OBJECT)).append(body)
  rt-fun("$obj_get", [list: anyref, E.reft(T-STR)], [list: anyref],
         # locals: 2=names(ref $Names), 3=i, 4=n (i32)
         [list: E.local-decl(1, E.reft(T-NAMES)), E.local-decl(2, i32t)], full-body)
end
# $obj_equal(a, b) -> i32 : same names in order, values $equal. locals: i=4, n=5 (i32);
# na=2, nb=3 (ref $Names).
fun emit-obj-equal() -> RtFun:
  body = blk(i32t, [list:
      E.local-get(0), E.struct-get(T-OBJECT, 0), E.local-set(2),
      E.local-get(1), E.struct-get(T-OBJECT, 0), E.local-set(3),
      E.local-get(2), E.array-len, E.local-set(5),
      E.local-get(5), E.local-get(3), E.array-len, E.i32-ne, iff([list: E.i32-const(0), E.i-br(1)]),
      E.i32-const(0), E.local-set(4),
      blk(E.bt-empty, [list:
        lp([list:
          E.local-get(4), E.local-get(5), E.i32-ge-s, iff([list: E.i-br(2)]),
          E.local-get(2), E.local-get(4), E.array-get(T-NAMES),
          E.local-get(3), E.local-get(4), E.array-get(T-NAMES), rt-call("$str_equal"), E.i32-eqz,
          iff([list: E.i32-const(0), E.i-br(3)]),
          E.local-get(0), E.struct-get(T-OBJECT, 1), E.local-get(4), E.array-get(T-FIELDS),
          E.local-get(1), E.struct-get(T-OBJECT, 1), E.local-get(4), E.array-get(T-FIELDS),
          rt-call("$equal"), E.i32-eqz,
          iff([list: E.i32-const(0), E.i-br(3)]),
          E.local-get(4), E.i32-const(1), E.i32-add, E.local-set(4),
          E.i-br(0) ]) ]),
      E.i32-const(1) ]).append(E.end-instr)
  rt-fun("$obj_equal", [list: E.reft(T-OBJECT), E.reft(T-OBJECT)], [list: i32t],
         # locals: 2=names-a, 3=names-b (ref $Names); 4=i, 5=n (i32)
         [list: E.local-decl(2, E.reft(T-NAMES)), E.local-decl(2, i32t)], body)
end
# $obj_extend(obj, nn, nv) -> $Object. New fields PREPENDED before base fields, so
# $obj_get's first-match returns the override (override + add). locals: bn=3(Names),
# bv=4(Fields), rn=5(Names), rv=6(Fields), nl=7(i32), bl=8(i32).
fun emit-obj-extend() -> RtFun:
  body = blk(E.reft(T-OBJECT), [list:
      E.local-get(0), E.struct-get(T-OBJECT, 0), E.local-set(3),
      E.local-get(0), E.struct-get(T-OBJECT, 1), E.local-set(4),
      E.local-get(1), E.array-len, E.local-set(7),
      E.local-get(3), E.array-len, E.local-set(8),
      # rn = array.new $Names (init = nn[0], size = nl+bl)
      E.local-get(1), E.i32-const(0), E.array-get(T-NAMES),
      E.local-get(7), E.local-get(8), E.i32-add, E.array-new(T-NAMES), E.local-set(5),
      # rv = array.new $Fields (init = null, size = nl+bl)
      E.i-ref-null(110),
      E.local-get(7), E.local-get(8), E.i32-add, E.array-new(T-FIELDS), E.local-set(6),
      E.local-get(5), E.i32-const(0), E.local-get(1), E.i32-const(0), E.local-get(7), E.array-copy(T-NAMES, T-NAMES),
      E.local-get(5), E.local-get(7), E.local-get(3), E.i32-const(0), E.local-get(8), E.array-copy(T-NAMES, T-NAMES),
      E.local-get(6), E.i32-const(0), E.local-get(2), E.i32-const(0), E.local-get(7), E.array-copy(T-FIELDS, T-FIELDS),
      E.local-get(6), E.local-get(7), E.local-get(4), E.i32-const(0), E.local-get(8), E.array-copy(T-FIELDS, T-FIELDS),
      E.local-get(5), E.local-get(6), E.struct-new(T-OBJECT) ]).append(E.end-instr)
  rt-fun("$obj_extend", [list: E.reft(T-OBJECT), E.reft(T-NAMES), E.reft(T-FIELDS)], [list: E.reft(T-OBJECT)],
         [list: E.local-decl(1, E.reft(T-NAMES)), E.local-decl(1, E.reft(T-FIELDS)),
                E.local-decl(1, E.reft(T-NAMES)), E.local-decl(1, E.reft(T-FIELDS)), E.local-decl(2, i32t)], body)
end
# $make_method(closure) -> $Method
fun emit-make-method() -> RtFun:
  body = E.local-get(0).append(E.struct-new(T-METHOD)).append(E.end-instr)
  rt-fun("$make_method", [list: E.reft(T-CLOSURE)], [list: E.reft(T-METHOD)], empty, body)
end
# $lookup_method(obj :: anyref, name :: $Str) -> anyref : find the method named `name`
# on `obj`.  A data VARIANT routes through the per-id method registry
# ($variant_methods[$variant_id(obj)]); any other value (a plain object) holds its
# methods directly.  Returns the field ($Method or plain closure), or null if absent.
# Mirrors the seed's compileMethodOnValue methodsSource lookup.
fun emit-lookup-method() -> RtFun:
  body = E.local-get(0).append(E.ref-test-null(T-VARIANT))
    .append(ifel-bt(anyref,
        [list: E.global-get(GI-VARIANT-METHODS), E.ref-cast(T-FIELDS),
               E.local-get(0), rt-call("$variant_id"), E.array-get(T-FIELDS) ],   # $variant_methods[id]
        [list: E.local-get(0) ]))                                                  # else obj itself
    .append(E.local-get(1)).append(rt-call("$obj_get"))
    .append(E.end-instr)
  rt-fun("$lookup_method", [list: anyref, E.reft(T-STR)], [list: anyref], empty, body)
end
# Closure-call func type index — MIRRORS wasm-of-pyret.arr `closure-call-type-idx`
# (= NUM-GC-TYPES + length(RT-FUNS)). NUM-GC-TYPES-RT MUST equal that file's NUM-GC-TYPES
# (13). $variant_match (below) is appended to all-runtime-funs, so both counts include it
# and stay consistent.
NUM-GC-TYPES-RT = 13
fun closure-call-tyidx() -> Number: NUM-GC-TYPES-RT + length(all-runtime-funs) end
# $variant_match(self, handlers, els) -> anyref : Pyret's auto-generated `_match` (the
# basis of `.visit()`; cf. seed compile.ts emitVariantMatch / runtime.js makeMatch).
# Dispatch the variant `self` on `handlers` (an $Object) by VARIANT NAME: if `handlers`
# has a field named like self's variant, call it with self's fields (a $Method binds
# handlers as self then the fields; a plain function field takes just the fields);
# otherwise call `els` (a closure) with self. Uses return_call_indirect (tail) so deep
# AST traversals run in constant stack. locals: 3=name(Str), 4=flds(?Fields),
# 5=ho(Object), 6=hn(Names), 7=i(i32), 8=n(i32), 9=handler(anyref), 10=clo(Closure),
# 11=args(Fields), 12=flen(i32).
fun emit-variant-match() -> RtFun:
  # tail-call a closure VALUE `clo-e` (anyref) with args $Fields `args-e` (via local 10).
  ct = lam(clo-e, args-e):
    seq([list:
      clo-e, E.ref-cast(T-CLOSURE), E.local-set(10),
      E.local-get(10),
      args-e,
      E.local-get(10), E.struct-get(T-CLOSURE, 0),
      E.i-return-call-indirect(closure-call-tyidx(), 0) ])
  end
  # handler is a $Method: call its closure with [handlers] ++ self.fields.
  method-path = seq([list:
    E.local-get(4), E.ref-is-null,
    ifel-bt(i32t, [list: E.i32-const(0)],
            [list: seq([list: E.local-get(4), E.ref-cast(T-FIELDS), E.array-len])]),
    E.local-set(12),
    E.i-ref-null(110), E.i32-const(1), E.local-get(12), E.i32-add, E.array-new(T-FIELDS), E.local-set(11),
    E.local-get(11), E.i32-const(0), E.local-get(1), E.array-set(T-FIELDS),
    E.local-get(12), E.i32-const(0), E.i32-gt-s,
    iff([list: E.local-get(11), E.i32-const(1), E.local-get(4), E.ref-cast(T-FIELDS),
               E.i32-const(0), E.local-get(12), E.array-copy(T-FIELDS, T-FIELDS)]),
    ct(seq([list: E.local-get(9), E.ref-cast(T-METHOD), E.struct-get(T-METHOD, 0)]), E.local-get(11)) ])
  # handler is a plain function field: call it with self.fields directly.
  plain-path = ct(E.local-get(9), E.local-get(4))
  found-dispatch = seq([list:
    E.local-get(5), E.struct-get(T-OBJECT, 1), E.local-get(7), E.array-get(T-FIELDS), E.local-set(9),
    E.local-get(9), E.ref-test-null(T-METHOD),
    ifel-bt(E.bt-empty, [list: method-path], [list: plain-path]) ])
  body = seq([list:
    E.local-get(0), E.ref-cast(T-VARIANT), E.struct-get(T-VARIANT, 1), E.local-set(3),  # name
    E.local-get(0), E.ref-cast(T-VARIANT), E.struct-get(T-VARIANT, 2), E.local-set(4),  # flds
    E.local-get(1), E.ref-cast(T-OBJECT), E.local-set(5),                                # ho
    E.local-get(5), E.struct-get(T-OBJECT, 0), E.local-set(6),                           # hn
    E.local-get(6), E.array-len, E.local-set(8),                                         # n
    E.i32-const(0), E.local-set(7),                                                      # i = 0
    blk(E.bt-empty, [list:
      lp([list:
        E.local-get(7), E.local-get(8), E.i32-ge-s, iff([list: E.i-br(2)]),  # i>=n -> exit search
        E.local-get(6), E.local-get(7), E.array-get(T-NAMES), E.local-get(3), rt-call("$str_equal"),
        iff([list: found-dispatch]),                                          # match -> dispatch (returns)
        E.local-get(7), E.i32-const(1), E.i32-add, E.local-set(7),
        E.i-br(0) ]) ]),
    ct(E.local-get(2), seq([list: E.local-get(0), E.array-new-fixed(T-FIELDS, 1)])) ]).append(E.end-instr)  # not found: els(self)
  rt-fun("$variant_match", [list: anyref, anyref, anyref], [list: anyref],
    [list: E.local-decl(1, E.reft(T-STR)), E.local-decl(1, E.reftnull(T-FIELDS)),
           E.local-decl(1, E.reft(T-OBJECT)), E.local-decl(1, E.reft(T-NAMES)),
           E.local-decl(2, i32t), E.local-decl(1, anyref),
           E.local-decl(1, E.reft(T-CLOSURE)), E.local-decl(1, E.reft(T-FIELDS)),
           E.local-decl(1, i32t) ], body)
end
# $empty_list() -> $Variant : the List `empty` (id = $empty_id global, null fields).
# (Correct once main sets $empty_id to List's empty variant id; -1 until then.)
fun emit-empty-list() -> RtFun:
  body = E.global-get(GI-EMPTY-ID).append(str-lit("empty")).append(E.array-new-fixed(T-FIELDS, 0))
    .append(rt-call("$make_variant")).append(E.end-instr)
  rt-fun("$empty_list", empty, [list: E.reft(T-VARIANT)], empty, body)
end
# $cons(head, tail) -> $Variant : the List `link` (id = $link_id global, 2-field $Fields).
fun emit-cons() -> RtFun:
  body = E.global-get(GI-LINK-ID).append(str-lit("link"))
    .append(E.local-get(0)).append(E.local-get(1)).append(E.array-new-fixed(T-FIELDS, 2))
    .append(rt-call("$make_variant")).append(E.end-instr)
  rt-fun("$cons", [list: anyref, anyref], [list: E.reft(T-VARIANT)], empty, body)
end

# ===== equality + rendering =====
# $equal(a, b) -> i32 : dispatch on a's representation (str/num/variant/object), each
# requiring b to match; i31 immediates (bools/nothing) compare by ref identity.
# (mirrors runtime.ts buildDispatch $equal.)
EQREF-HT = 109
fun both-test-eq(t :: Number, callee :: String) -> List<Number>:
  # a already known to be `t`; require b is `t` too, then call callee(cast a, cast b).
  E.local-get(1).append(E.ref-test-null(t))
    .append(ifel-bt(i32t,
        [list: E.local-get(0), E.ref-cast(t), E.local-get(1), E.ref-cast(t), rt-call(callee)],
        [list: E.i32-const(0)]))
end
fun emit-equal() -> RtFun:
  body = E.local-get(0).append(E.ref-test-null(T-STR))
    .append(ifel-bt(i32t, [list: both-test-eq(T-STR, "$str_equal")], [list:
      E.local-get(0).append(E.ref-test-null(T-NUM))
        .append(ifel-bt(i32t, [list: both-test-eq(T-NUM, "$num_equal")], [list:
          E.local-get(0).append(E.ref-test-null(T-VARIANT))
            .append(ifel-bt(i32t, [list: both-test-eq(T-VARIANT, "$variant_equal")], [list:
              E.local-get(0).append(E.ref-test-null(T-OBJECT))
                .append(ifel-bt(i32t, [list: both-test-eq(T-OBJECT, "$obj_equal")], [list:
                  E.local-get(0), E.ref-cast(EQREF-HT), E.local-get(1), E.ref-cast(EQREF-HT), E.ref-eq ])) ])) ])) ]))
    .append(E.end-instr)
  rt-fun("$equal", [list: anyref, anyref], [list: i32t], empty, body)
end
HT-I31 = 108   # abstract i31 heaptype (for ref.cast / i31.get_s of bools/nothing)
# $render(v :: anyref, addr :: i32) -> i32 end-addr. Cursor renderer: dispatch on the
# value's representation, append text at `addr`, return the new cursor.
fun emit-render() -> RtFun:
  body = blk(i32t, [list:
      E.local-get(0), E.ref-test-null(T-STR), iff([list:
        E.local-get(1), E.local-get(0), E.ref-cast(T-STR), E.local-get(1), rt-call("$str_copy"), E.i32-add, E.i-br(1) ]),
      E.local-get(0), E.ref-test-null(T-NUM), iff([list:
        E.local-get(0), E.ref-cast(T-NUM), E.local-get(1), rt-call("$render_num"), E.i-br(1) ]),
      E.local-get(0), E.ref-test-null(T-VARIANT), iff([list:
        E.local-get(0), E.ref-cast(T-VARIANT), E.local-get(1), rt-call("$render_variant"), E.i-br(1) ]),
      E.local-get(0), E.ref-test-null(T-OBJECT), iff([list:
        E.local-get(0), E.ref-cast(T-OBJECT), E.local-get(1), rt-call("$render_object"), E.i-br(1) ]),
      # i31 immediates: 1 -> "true", 0 -> "false", else "nothing"
      E.local-get(0), E.ref-cast(HT-I31), E.i31-get-s, E.i32-const(1), E.i32-eq, iff([list:
        lit-at(1, "true"), E.local-get(1), E.i32-const(4), E.i32-add, E.i-br(1) ]),
      E.local-get(0), E.ref-cast(HT-I31), E.i31-get-s, E.i32-const(0), E.i32-eq, iff([list:
        lit-at(1, "false"), E.local-get(1), E.i32-const(5), E.i32-add, E.i-br(1) ]),
      lit-at(1, "nothing"), E.local-get(1), E.i32-const(7), E.i32-add ]).append(E.end-instr)
  rt-fun("$render", [list: anyref, i32t], [list: i32t], empty, body)
end
# $render_variant(v, addr) -> end addr.  tuples -> {..}, lists -> [list: ..], else
# name "(" f0 ", " f1 ... ")".  locals: a=2, fields=3(reftnull Fields), i=4, n=5.
fun emit-render-variant() -> RtFun:
  body = blk(i32t, [list:
      E.local-get(0), E.struct-get(T-VARIANT, 0), E.i32-const(-1), E.i32-eq, iff([list:
        E.local-get(0), E.local-get(1), rt-call("$render_tuple"), E.i-br(1) ]),
      E.local-get(0), E.struct-get(T-VARIANT, 0), E.global-get(GI-LINK-ID), E.i32-eq,
      E.local-get(0), E.struct-get(T-VARIANT, 0), E.global-get(GI-EMPTY-ID), E.i32-eq, E.i32-or, iff([list:
        E.local-get(0), E.local-get(1), rt-call("$render_list"), E.i-br(1) ]),
      E.local-get(1), E.local-get(0), E.struct-get(T-VARIANT, 1), E.local-get(1), rt-call("$str_copy"), E.i32-add, E.local-set(2),
      E.local-get(0), E.struct-get(T-VARIANT, 2), E.local-set(3),
      E.local-get(3), E.ref-is-null, iff([list: E.local-get(2), E.i-br(1) ]),
      E.local-get(3), E.array-len, E.local-set(5),
      E.local-get(5), E.i32-eqz, iff([list: E.local-get(2), E.i-br(1) ]),
      E.local-get(2), E.i32-const(40), E.i32-store8,
      E.local-get(2), E.i32-const(1), E.i32-add, E.local-set(2),
      E.i32-const(0), E.local-set(4),
      blk(E.bt-empty, [list:
        lp([list:
          E.local-get(4), E.local-get(5), E.i32-ge-s, iff([list: E.i-br(2)]),
          E.local-get(4), E.i32-const(0), E.i32-gt-s, iff([list:
            E.local-get(2), E.i32-const(44), E.i32-store8,
            E.local-get(2), E.i32-const(1), E.i32-add, E.i32-const(32), E.i32-store8,
            E.local-get(2), E.i32-const(2), E.i32-add, E.local-set(2) ]),
          E.local-get(3), E.local-get(4), E.array-get(T-FIELDS), E.local-get(2), rt-call("$render"), E.local-set(2),
          E.local-get(4), E.i32-const(1), E.i32-add, E.local-set(4),
          E.i-br(0) ]) ]),
      E.local-get(2), E.i32-const(41), E.i32-store8,
      E.local-get(2), E.i32-const(1), E.i32-add ]).append(E.end-instr)
  rt-fun("$render_variant", [list: E.reft(T-VARIANT), i32t], [list: i32t],
         [list: E.local-decl(1, i32t), E.local-decl(1, E.reftnull(T-FIELDS)), E.local-decl(2, i32t)], body)
end
# $render_list(v, addr) -> end addr.  "[list: a, b, c]". locals: a=2, cur=3(Variant), first=4.
fun emit-render-list() -> RtFun:
  body = blk(i32t, [list:
      E.local-get(1), E.local-set(2),
      lit-at(2, "[list: "),
      E.local-get(2), E.i32-const(7), E.i32-add, E.local-set(2),
      E.local-get(0), E.local-set(3),
      E.i32-const(1), E.local-set(4),
      blk(E.bt-empty, [list:
        lp([list:
          E.local-get(3), E.struct-get(T-VARIANT, 0), E.global-get(GI-EMPTY-ID), E.i32-eq, iff([list: E.i-br(2)]),
          E.local-get(4), E.i32-eqz, iff([list:
            E.local-get(2), E.i32-const(44), E.i32-store8,
            E.local-get(2), E.i32-const(1), E.i32-add, E.i32-const(32), E.i32-store8,
            E.local-get(2), E.i32-const(2), E.i32-add, E.local-set(2) ]),
          E.i32-const(0), E.local-set(4),
          E.local-get(3), E.struct-get(T-VARIANT, 2), E.i32-const(0), E.array-get(T-FIELDS), E.local-get(2), rt-call("$render"), E.local-set(2),
          E.local-get(3), E.struct-get(T-VARIANT, 2), E.i32-const(1), E.array-get(T-FIELDS), E.ref-cast(T-VARIANT), E.local-set(3),
          E.i-br(0) ]) ]),
      E.local-get(2), E.i32-const(93), E.i32-store8,
      E.local-get(2), E.i32-const(1), E.i32-add ]).append(E.end-instr)
  rt-fun("$render_list", [list: E.reft(T-VARIANT), i32t], [list: i32t],
         [list: E.local-decl(1, i32t), E.local-decl(1, E.reft(T-VARIANT)), E.local-decl(1, i32t)], body)
end
# $render_tuple(v, addr) -> end addr.  "{a; b; c}". locals: a=2, flds=3(reftnull Fields), i=4, n=5.
fun emit-render-tuple() -> RtFun:
  body = blk(i32t, [list:
      E.local-get(1), E.local-set(2),
      E.local-get(2), E.i32-const(123), E.i32-store8,
      E.local-get(2), E.i32-const(1), E.i32-add, E.local-set(2),
      E.local-get(0), E.struct-get(T-VARIANT, 2), E.local-set(3),
      E.local-get(3), E.ref-is-null, iff([list:
        E.local-get(2), E.i32-const(125), E.i32-store8,
        E.local-get(2), E.i32-const(1), E.i32-add, E.i-br(1) ]),
      E.local-get(3), E.array-len, E.local-set(5),
      E.i32-const(0), E.local-set(4),
      blk(E.bt-empty, [list:
        lp([list:
          E.local-get(4), E.local-get(5), E.i32-ge-s, iff([list: E.i-br(2)]),
          E.local-get(4), E.i32-const(0), E.i32-gt-s, iff([list:
            E.local-get(2), E.i32-const(59), E.i32-store8,
            E.local-get(2), E.i32-const(1), E.i32-add, E.i32-const(32), E.i32-store8,
            E.local-get(2), E.i32-const(2), E.i32-add, E.local-set(2) ]),
          E.local-get(3), E.local-get(4), E.array-get(T-FIELDS), E.local-get(2), rt-call("$render"), E.local-set(2),
          E.local-get(4), E.i32-const(1), E.i32-add, E.local-set(4),
          E.i-br(0) ]) ]),
      E.local-get(2), E.i32-const(125), E.i32-store8,
      E.local-get(2), E.i32-const(1), E.i32-add ]).append(E.end-instr)
  rt-fun("$render_tuple", [list: E.reft(T-VARIANT), i32t], [list: i32t],
         [list: E.local-decl(1, i32t), E.local-decl(1, E.reftnull(T-FIELDS)), E.local-decl(2, i32t)], body)
end
# $render_object(obj, addr) -> end addr.  "{name: value, ...}". a is param local 1.
# locals: names=2(Names), i=3, n=4.
fun emit-render-object() -> RtFun:
  body = blk(i32t, [list:
      E.local-get(0), E.struct-get(T-OBJECT, 0), E.local-set(2),
      E.local-get(2), E.array-len, E.local-set(4),
      E.local-get(1), E.i32-const(123), E.i32-store8,
      E.local-get(1), E.i32-const(1), E.i32-add, E.local-set(1),
      E.i32-const(0), E.local-set(3),
      blk(E.bt-empty, [list:
        lp([list:
          E.local-get(3), E.local-get(4), E.i32-ge-s, iff([list: E.i-br(2)]),
          E.local-get(3), E.i32-const(0), E.i32-gt-s, iff([list:
            E.local-get(1), E.i32-const(44), E.i32-store8,
            E.local-get(1), E.i32-const(1), E.i32-add, E.i32-const(32), E.i32-store8,
            E.local-get(1), E.i32-const(2), E.i32-add, E.local-set(1) ]),
          E.local-get(1), E.local-get(2), E.local-get(3), E.array-get(T-NAMES), E.local-get(1), rt-call("$str_copy"), E.i32-add, E.local-set(1),
          E.local-get(1), E.i32-const(58), E.i32-store8,
          E.local-get(1), E.i32-const(1), E.i32-add, E.i32-const(32), E.i32-store8,
          E.local-get(1), E.i32-const(2), E.i32-add, E.local-set(1),
          E.local-get(0), E.struct-get(T-OBJECT, 1), E.local-get(3), E.array-get(T-FIELDS), E.local-get(1), rt-call("$render"), E.local-set(1),
          E.local-get(3), E.i32-const(1), E.i32-add, E.local-set(3),
          E.i-br(0) ]) ]),
      E.local-get(1), E.i32-const(125), E.i32-store8,
      E.local-get(1), E.i32-const(1), E.i32-add ]).append(E.end-instr)
  rt-fun("$render_object", [list: E.reft(T-OBJECT), i32t], [list: i32t],
         [list: E.local-decl(1, E.reft(T-NAMES)), E.local-decl(2, i32t)], body)
end
# $val_to_string(v) -> i32 length written at SCRATCH-OFFSET.
fun emit-val-to-string() -> RtFun:
  body = E.local-get(0).append(E.i32-const(SCRATCH-OFFSET)).append(rt-call("$render"))
    .append(E.i32-const(SCRATCH-OFFSET)).append(E.i32-sub).append(E.end-instr)
  rt-fun("$val_to_string", [list: anyref], [list: i32t], empty, body)
end

# ===== check harness ===== (drive scoreboard globals + report via host imports)
# bump $total; on success bump $passed; on failure stash both rendered values to the host.
fun bump(gi :: Number) -> List<Number>:
  E.global-get(gi).append(E.i32-const(1)).append(E.i32-add).append(E.global-set(gi))
end
fun emit-check-is() -> RtFun:
  body = bump(GI-TOTAL)
    .append(E.local-get(0)).append(E.local-get(1)).append(rt-call("$equal"))
    .append(ifel-bt(E.bt-empty, [list: bump(GI-PASSED)],
        [list:
          E.local-get(0), rt-call("$val_to_string"), E.local-set(2),
          E.i32-const(SCRATCH-OFFSET), E.local-get(2), E.i-call(host-import-index("check_stash")),
          E.local-get(1), rt-call("$val_to_string"), E.local-set(2),
          E.i32-const(SCRATCH-OFFSET), E.local-get(2), E.i-call(host-import-index("check_fail")) ]))
    .append(E.end-instr)
  rt-fun("$check_is", [list: anyref, anyref], empty, [list: E.local-decl(1, i32t)], body)
end
fun emit-check-is-not() -> RtFun:
  body = bump(GI-TOTAL)
    .append(E.local-get(0)).append(E.local-get(1)).append(rt-call("$equal")).append(E.i32-eqz)
    .append(ifel-bt(E.bt-empty, [list: bump(GI-PASSED)],
        [list:
          E.local-get(0), rt-call("$val_to_string"), E.local-set(2),
          E.i32-const(SCRATCH-OFFSET), E.local-get(2), E.i-call(host-import-index("check_stash")),
          E.local-get(1), rt-call("$val_to_string"), E.local-set(2),
          E.i32-const(SCRATCH-OFFSET), E.local-get(2), E.i-call(host-import-index("check_fail_isnot")) ]))
    .append(E.end-instr)
  rt-fun("$check_is_not", [list: anyref, anyref], empty, [list: E.local-decl(1, i32t)], body)
end
fun emit-check-pred() -> RtFun:
  body = bump(GI-TOTAL)
    .append(E.local-get(0))
    .append(ifel-bt(E.bt-empty, [list: bump(GI-PASSED)],
        [list: E.i32-const(0), E.i32-const(0), E.i-call(host-import-index("check_fail_pred"))]))
    .append(E.end-instr)
  rt-fun("$check_pred", [list: i32t], empty, empty, body)
end

# ===== CPS stop-button primitives (compile.arr adds these in {stoppable}) =====
fun emit-yield() -> RtFun: todo("$yield", "decrement $gas; if>0 tail-call thunk closure; else reset+store paused_thunk+call $do_pause; unreachable") end

# The full ordered list (indices must match compile.arr's references).
all-runtime-funs :: List<String> = [list:
  "$make_fix","$make_rat","$make_rough","$plus",
  "$minus","$times","$divide",
  "$lessthan","$greaterthan","$lessequal","$greaterequal",
  "$equal_wrap",
  "$num_equal","$num_compare",
  "$num_modulo","$num_quotient","$num_expt","$num_to_i32","$num_to_string","$to_f64",
  "$mag_add","$mag_sub","$mag_mul","$mag_cmp","$mag_divmod","$mag_gcd",
  "$string_length","$str_concat","$str_equal","$str_from_mem","$str_to_codepoints",
  "$make_variant","$variant_id","$variant_field","$variant_field_by_name","$variant_equal",
  "$make_object","$obj_get","$obj_equal","$obj_extend","$make_method","$lookup_method","$cons","$empty_list",
  "$equal","$render","$val_to_string",
  "$check_is","$check_is_not","$check_pred","$yield",
  # renderer helpers + decimal writer + str-copy (appended; order parallels build-runtime)
  "$render_num","$write_i64","$str_copy","$render_variant","$render_list","$render_tuple","$render_object",
  "$variant_match" ]

# Assemble all runtime functions in order. TODO bodies trap; fleshed ones are real.
fun build-runtime() -> List<RtFun>:
  [list:
    emit-make-fix(), emit-make-rat(), emit-make-rough(), emit-plus(),
    emit-minus(), emit-times(), emit-divide(),
    emit-lessthan(), emit-greaterthan(), emit-lessequal(), emit-greaterequal(),
    emit-equal-wrap(),
    emit-num-equal(),
    emit-num-compare(), emit-num-modulo(), emit-num-quotient(), emit-num-expt(),
    emit-num-to-i32(), emit-num-to-string(), emit-to-f64(),
    emit-mag-add(), emit-mag-sub(), emit-mag-mul(), emit-mag-cmp(), emit-mag-divmod(), emit-mag-gcd(),
    emit-string-length(), emit-str-concat(), emit-str-equal(), emit-str-from-mem(), emit-str-to-codepoints(),
    emit-make-variant(), emit-variant-id(), emit-variant-field(), emit-variant-field-by-name(), emit-variant-equal(),
    emit-make-object(), emit-obj-get(), emit-obj-equal(), emit-obj-extend(), emit-make-method(), emit-lookup-method(), emit-cons(), emit-empty-list(),
    emit-equal(), emit-render(), emit-val-to-string(),
    emit-check-is(), emit-check-is-not(), emit-check-pred(), emit-yield(),
    emit-render-num(), emit-write-i64(), emit-str-copy(),
    emit-render-variant(), emit-render-list(), emit-render-tuple(), emit-render-object(),
    emit-variant-match() ]
end
