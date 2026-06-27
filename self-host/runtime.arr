#lang pyret
# PORT (sketch) of src/compiler/runtime.ts — emits the WASM runtime (number tower,
# value model, strings, variants/objects, equality, rendering, the check harness,
# and the CPS yield/resume primitives) via encoder.arr. compile.arr installs these
# functions into the module and refers to them by index.
#
# SKETCH STATUS: a faithful CATALOG of the 69 runtime functions runtime.ts emits,
# grouped as there. Bodies are TODO(port) — each `emit-*` should build the function's
# WASM via encoder.arr (E.*). The hard numeric kernels (bignum long division, gcd) are
# the biggest bodies; their structure is noted. Keep this list in lockstep with
# runtime.ts so the seed and the self-hosted compiler emit the same runtime.

provide *
import encoder as E

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

# The full ordered list the module installs (indices must match compile.arr refs).
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
