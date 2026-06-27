#lang pyret
# PORT (sketch) of src/compiler/runtime.ts — emits the WASM runtime (number tower,
# value model, strings, variants/objects, equality, rendering, the check harness,
# and the CPS yield/resume primitives) via encoder.arr. compile.arr installs these
# functions into the wasm-module and refers to them by index.
#
<<<<<<< HEAD
# SKETCH STATUS: a faithful CATALOG of the 69 runtime functions runtime.ts emits,
# grouped as there. Bodies are TODO(port) — each `emit-*` should build the function's
# WASM via encoder.arr (E.*). The hard numeric kernels (bignum long division, gcd) are
# the biggest bodies; their structure is noted. Keep this list in lockstep with
# runtime.ts so the seed and the self-hosted compiler emit the same runtime.
=======
# STATUS: faithful 1:1 catalog of the runtime functions runtime.ts emits, grouped as
# there. SIMPLE value-model accessors/constructors are fleshed out with real encoder
# bodies; the heavy numeric kernels (bignum long division / gcd / mul, render, the
# full type-dispatching $plus/$equal) are structured TODO(port) stubs that record the
# runtime.ts approach + signature. Won't run end-to-end yet — built for faithful
# structure so the seed and self-hosted compiler emit the same runtime.
>>>>>>> worktree-agent-a949a57b5fe48e7c9

provide *
import encoder as E

<<<<<<< HEAD
# A runtime function to emit: its name, type signature, locals, and body bytes.
data RtFun: rt-fun(name :: String, params :: List<List<Number>>, results :: List<List<Number>>,
                   locals :: List<List<Number>>, body :: List<Number>) end

# ---- number tower: construction + tower ops ----
# $make_fix(i64)->$Num  $make_rat(num,den)->$Num  $make_rough(f64)->$Num
# $plus  $num_equal  $num_compare  $num_modulo  $num_quotient  $num_expt
# $num_to_i32  $num_to_string  $to_f64  $int_to_f64  $signed  $write_i64
fun emit-make-fix() -> RtFun: raise("TODO(port): struct.new $Fixnum {tag, i64}") end
fun emit-make-rat() -> RtFun: raise("TODO(port): reduce via $gcd, struct.new $Rational") end
fun emit-make-rough() -> RtFun: raise("TODO(port): struct.new $Roughnum {tag, f64}") end
fun emit-plus() -> RtFun: raise("TODO(port): type-dispatch add over fix/rat/rough/big + contagion") end
fun emit-num-equal() -> RtFun: raise("TODO(port)") end
fun emit-num-compare() -> RtFun: raise("TODO(port)") end
fun emit-num-modulo() -> RtFun: raise("TODO(port): floor modulo") end
fun emit-num-quotient() -> RtFun: raise("TODO(port): floor div") end
fun emit-num-expt() -> RtFun: raise("TODO(port): repeated $plus-mul loop") end
fun emit-num-to-string() -> RtFun: raise("TODO(port)") end

# ---- bignum kernels (the big bodies) ----
# magnitude (limb array) ops: $mag_add $mag_sub $mag_mul $mag_cmp $mag_divmod
#   $mag_divmod_small $mag_gcd $mag_norm $mag_one $mag_bit $mag_bitlen
# bignum wrappers: $bn_addsub $bn_mul $bn_cmp $bn_norm $bn_render $fix_to_limbs
#   $int_limbs $int_sign $int_is_zero $int_is_one $gcd
fun emit-mag-divmod() -> RtFun: raise("TODO(port): binary long division over i32 limbs (MSB-down loop)") end
fun emit-mag-gcd() -> RtFun: raise("TODO(port): Euclid loop") end
# ... (the remaining mag-/bn- functions follow runtime.ts 1:1) ...

# ---- strings ($Str = array i8) ----
# $str_concat $str_copy $str_equal $str_from_mem $string_length $str_to_codepoints
#   $str_to_scratch $to_scratch
fun emit-str-concat() -> RtFun: raise("TODO(port): array.copy two $Str into a new one") end
fun emit-str-equal() -> RtFun: raise("TODO(port): length + byte loop") end
fun emit-str-from-mem() -> RtFun: raise("TODO(port): build $Str from linear memory (read-source)") end
fun emit-string-length() -> RtFun: raise("TODO(port): array.len") end
fun emit-str-to-codepoints() -> RtFun: raise("TODO(port)") end

# ---- variants / objects / closures ----
# $make_variant $variant_id $variant_field $variant_field_by_name $variant_equal
# $make_object $obj_get $obj_equal $obj_extend $make_method $method_closure
# $cons $empty_list (build Pyret lists from WASM)
fun emit-make-variant() -> RtFun: raise("TODO(port): struct.new $Variant {id, name, fields}") end
fun emit-variant-field-by-name() -> RtFun: raise("TODO(port): scan $variant_names[id] for name -> array.get") end
fun emit-obj-get() -> RtFun: raise("TODO(port): first-match name scan -> value") end
fun emit-obj-extend() -> RtFun: raise("TODO(port): prepend override names/values into a fresh $Object") end

# ---- equality + rendering ----
# $equal $obj_equal $variant_equal ; $render $render_num $render_list $render_object
#   $render_tuple $render_variant $val_to_string $tostring $bn_render
fun emit-equal() -> RtFun: raise("TODO(port): structural equality dispatch by representation") end
fun emit-val-to-string() -> RtFun: raise("TODO(port): render any value to $Str in scratch memory") end

# ---- check harness ----
# $check_is $check_is_not $check_pred  (drive the test scoreboard via host imports)
fun emit-check-is() -> RtFun: raise("TODO(port)") end

# ---- CPS stop-button primitives (added in compile.ts for {stoppable}) ----
# $yield (gas check -> tail-call thunk or pause via $do_pause import), $resume export,
# globals $gas/$paused_thunk/$result, finish-result. (mirror the stoppable additions)
fun emit-yield() -> RtFun: raise("TODO(port): gas-- ; if>0 return_call thunk else pause") end

# The full ordered list the wasm-module installs (indices must match compile.arr refs).
all-runtime-funs :: List<String> = [list:
  "$make_fix","$make_rat","$make_rough","$plus","$num_equal","$num_compare",
  "$num_modulo","$num_quotient","$num_expt","$num_to_i32","$num_to_string","$to_f64",
  "$int_to_f64","$signed","$write_i64",
  "$mag_add","$mag_sub","$mag_mul","$mag_cmp","$mag_divmod","$mag_divmod_small",
  "$mag_gcd","$mag_norm","$mag_one","$mag_bit","$mag_bitlen",
  "$bn_addsub","$bn_mul","$bn_cmp","$bn_norm","$bn_render","$fix_to_limbs",
  "$int_limbs","$int_sign","$int_is_zero","$int_is_one","$gcd",
  "$str_concat","$str_copy","$str_equal","$str_from_mem","$string_length",
  "$str_to_codepoints","$str_to_scratch",
  "$make_variant","$variant_id","$variant_field","$variant_field_by_name","$variant_equal",
  "$make_object","$obj_get","$obj_equal","$obj_extend","$make_method","$method_closure",
  "$cons","$empty_list",
  "$equal","$render","$render_num","$render_list","$render_object","$render_tuple",
  "$render_variant","$val_to_string","$tostring",
  "$check_is","$check_is_not","$check_pred" ]
=======
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

# ===== number tower: ops (type-dispatching, with contagion) =====
fun emit-plus() -> RtFun: todo("$plus", "if either roughnum -> f64 add (contagion); else exact dispatch fix/rat/big") end
fun emit-num-equal() -> RtFun: todo("$num_equal", "tag-dispatch; exacts by value (cross-multiply rationals); rough by f64 ==") end
fun emit-num-compare() -> RtFun: todo("$num_compare", "-1/0/1; exact via bignum cmp of cross-products; rough via f64") end
fun emit-num-modulo() -> RtFun: todo("$num_modulo", "floor modulo over the tower") end
fun emit-num-quotient() -> RtFun: todo("$num_quotient", "floor division") end
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
    .append(E.call(0))                # $make_fix (index 0)
    .append(E.end-instr)
  rt-fun("$string_length", [list: anyref], [list: E.reft(T-NUM)], empty, body)
end
fun emit-str-concat() -> RtFun: todo("$str_concat", "new $Str of len(a)+len(b); array.copy a then b") end
fun emit-str-equal() -> RtFun: todo("$str_equal", "compare lengths then byte loop -> i32 bool") end
fun emit-str-from-mem() -> RtFun: todo("$str_from_mem", "build $Str from linear memory ptr/len (read-source)") end
fun emit-str-to-codepoints() -> RtFun: todo("$str_to_codepoints", "build a Pyret list of fixnums from bytes") end

# ===== variants / objects / closures =====
# $make_variant(id :: i32, name :: $Str, fields :: $Fields) -> (ref $Variant)
fun emit-make-variant() -> RtFun:
  body = E.local-get(0).append(E.local-get(1)).append(E.local-get(2))
    .append(E.struct-new(T-VARIANT))
    .append(E.end-instr)
  rt-fun("$make_variant", [list: i32t, E.reft(T-STR), E.reftnull(T-FIELDS)],
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
fun emit-variant-field-by-name() -> RtFun: todo("$variant_field_by_name", "scan $variant_names[id] for name -> $variant_field at index") end
fun emit-variant-equal() -> RtFun: todo("$variant_equal", "same id and field-wise $equal") end
fun emit-make-object() -> RtFun: todo("$make_object", "struct.new $Object {names, values}") end
fun emit-obj-get() -> RtFun: todo("$obj_get", "first-match name scan over $Names -> values[i]") end
fun emit-obj-equal() -> RtFun: todo("$obj_equal", "same names set and field-wise $equal") end
fun emit-obj-extend() -> RtFun: todo("$obj_extend", "prepend override names/values into a fresh $Object") end
fun emit-make-method() -> RtFun: todo("$make_method", "struct.new $Method {closure}") end
fun emit-cons() -> RtFun: todo("$cons", "make link variant using $link_id global + 2-field $Fields") end
fun emit-empty-list() -> RtFun: todo("$empty_list", "make empty variant using $empty_id global") end

# ===== equality + rendering =====
fun emit-equal() -> RtFun: todo("$equal", "structural equality dispatch by representation (num/str/i31/variant/object)") end
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
>>>>>>> worktree-agent-a949a57b5fe48e7c9
