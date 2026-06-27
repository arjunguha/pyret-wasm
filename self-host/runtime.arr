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
# ($equal, dispatching str/num/variant/object/i31). build-runtime() executes and emits
# 42 functions / ~1KB of real body bytes.
# STILL TODO(port): the rough/rational/bignum number tower (all $mag_*, $make_rat,
# $to_f64, $num_expt, $num_to_string), the linear-memory RENDERER ($render/$render_*/
# $val_to_string) and the CHECK HARNESS ($check_is/$check_is_not/$check_pred) that
# depends on it, $obj_extend, $cons/$empty_list (need $link_id/$empty_id globals),
# $str_from_mem/$str_to_codepoints, and the CPS $yield primitive.
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
fun emit-num-expt() -> RtFun: todo("$num_expt", "repeated $num_mul loop, non-neg integer exponent") end

# $num_to_i32(($Num)) -> i32 : assume fixnum, read i64 field, wrap to i32
fun emit-num-to-i32() -> RtFun:
  body = E.local-get(0)
    .append(E.ref-cast(T-FIX))
    .append(E.struct-get(T-FIX, 1))   # the i64
    .append([list: 167])              # i32.wrap_i64
    .append(E.end-instr)
  rt-fun("$num_to_i32", [list: anyref], [list: i32t], empty, body)
end

fun emit-to-f64() -> RtFun: todo("$to_f64", "dispatch: fix -> f64.convert_i64; rough -> field; rat -> num/den; big -> limbs->f64") end
fun emit-num-to-string() -> RtFun: todo("$num_to_string", "render number to $Str in scratch: int decimal / rational a/b / rough format") end

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
fun emit-str-from-mem() -> RtFun: todo("$str_from_mem", "build $Str from linear memory ptr/len (read-source)") end
fun emit-str-to-codepoints() -> RtFun: todo("$str_to_codepoints", "build a Pyret list of fixnums from bytes") end

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
      E.global-get(0), E.local-get(2), E.array-get(T-FIELDS), E.ref-cast(T-NAMES), E.local-set(3),
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
# locals: i=3, n=4 (i32); names=2 (ref $Names).
fun emit-obj-get() -> RtFun:
  body = blk(anyref, [list:
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
      raise-host() ]).append(E.end-instr)
  rt-fun("$obj_get", [list: anyref, E.reft(T-STR)], [list: anyref],
         # locals: 2=names(ref $Names), 3=i, 4=n (i32)
         [list: E.local-decl(1, E.reft(T-NAMES)), E.local-decl(2, i32t)], body)
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
fun emit-obj-extend() -> RtFun: todo("$obj_extend", "prepend override names/values into a fresh $Object") end
# $make_method(closure) -> $Method
fun emit-make-method() -> RtFun:
  body = E.local-get(0).append(E.struct-new(T-METHOD)).append(E.end-instr)
  rt-fun("$make_method", [list: E.reft(T-CLOSURE)], [list: E.reft(T-METHOD)], empty, body)
end
fun emit-cons() -> RtFun: todo("$cons", "make link variant using $link_id global + 2-field $Fields") end
fun emit-empty-list() -> RtFun: todo("$empty_list", "make empty variant using $empty_id global") end

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
fun emit-render() -> RtFun: todo("$render", "render any value to $Str (recursive; lists as [list: ...])") end
fun emit-val-to-string() -> RtFun: todo("$val_to_string", "render result into scratch memory; return length for $print") end

# ===== check harness ===== (drive scoreboard via host imports)
fun emit-check-is() -> RtFun: todo("$check_is", "compare via $equal; call host check_stash/check_fail") end
fun emit-check-is-not() -> RtFun: todo("$check_is_not", "negated $check_is") end
fun emit-check-pred() -> RtFun: todo("$check_pred", "call predicate; host check_fail_pred on false") end

# ===== CPS stop-button primitives (compile.arr adds these in {stoppable}) =====
fun emit-yield() -> RtFun: todo("$yield", "decrement $gas; if>0 tail-call thunk closure; else reset+store paused_thunk+call $do_pause; unreachable") end

# The full ordered list (indices must match compile.arr's references).
all-runtime-funs :: List<String> = [list:
  "$make_fix","$make_rat","$make_rough","$plus","$num_equal","$num_compare",
  "$num_modulo","$num_quotient","$num_expt","$num_to_i32","$num_to_string","$to_f64",
  "$mag_add","$mag_sub","$mag_mul","$mag_cmp","$mag_divmod","$mag_gcd",
  "$string_length","$str_concat","$str_equal","$str_from_mem","$str_to_codepoints",
  "$make_variant","$variant_id","$variant_field","$variant_field_by_name","$variant_equal",
  "$make_object","$obj_get","$obj_equal","$obj_extend","$make_method","$cons","$empty_list",
  "$equal","$render","$val_to_string",
  "$check_is","$check_is_not","$check_pred","$yield" ]

# Assemble all runtime functions in order. TODO bodies trap; fleshed ones are real.
fun build-runtime() -> List<RtFun>:
  [list:
    emit-make-fix(), emit-make-rat(), emit-make-rough(), emit-plus(), emit-num-equal(),
    emit-num-compare(), emit-num-modulo(), emit-num-quotient(), emit-num-expt(),
    emit-num-to-i32(), emit-num-to-string(), emit-to-f64(),
    emit-mag-add(), emit-mag-sub(), emit-mag-mul(), emit-mag-cmp(), emit-mag-divmod(), emit-mag-gcd(),
    emit-string-length(), emit-str-concat(), emit-str-equal(), emit-str-from-mem(), emit-str-to-codepoints(),
    emit-make-variant(), emit-variant-id(), emit-variant-field(), emit-variant-field-by-name(), emit-variant-equal(),
    emit-make-object(), emit-obj-get(), emit-obj-equal(), emit-obj-extend(), emit-make-method(), emit-cons(), emit-empty-list(),
    emit-equal(), emit-render(), emit-val-to-string(),
    emit-check-is(), emit-check-is-not(), emit-check-pred(), emit-yield() ]
end
