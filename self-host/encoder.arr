provide *
# WASM-GC binary encoder, written in Pyret — the binaryen replacement for the
# self-hosted compiler. Mirrors the byte sequences src/compiler/{types,runtime,
# compile}.ts produce via binaryen. Lists of bytes (0..255) are the unit of output;
# `concat-bytes`/`append` join them; sections wrap them. NOT yet run end-to-end.
#
# Opcode references (from the seed's emitted .wat / binaryen disassembly):
#   value types: i32=127 i64=126 f64=124 v128=123 funcref=112 externref=111
#                anyref=110 eqref=109 i31ref=108 structref=107 arrayref=106
#   (ref null ht)=99,ht   (ref ht)=100,ht
#   comptypes: func=96 struct=95 array=94 ; sub=80 sub-final=79? ; rec-group=78
#   GC ops (prefix 0xFB=251): struct.new=0 struct.new_default=1 struct.get=2
#     struct.get_s=3 struct.get_u=4 struct.set=5 array.new=6 array.new_default=7
#     array.new_fixed=8 array.get=11 array.get_s=12 array.get_u=13 array.set=14
#     array.len=15 ref.test=20 ref.test_null=21 ref.cast=22 ref.cast_null=23
#     ref.i31=28 i31.get_s=29 i31.get_u=30
#   ref.null ht = 208,ht (0xD0) ; ref.func=210 ; ref.is_null=209
#   control: unreachable=0 nop=1 block=2 loop=3 if=4 else=5 end=11 br=12 br_if=13
#     return=15 call=16 call_indirect=17 return_call=18 return_call_indirect=19
#   parametric: drop=26 select=27
#   vars: local.get=32 local.set=33 local.tee=34 global.get=35 global.set=36
#   const: i32.const=65 i64.const=66 f32.const=67 f64.const=68

# ===== LEB128 + list helpers =====
fun leb-u(n):
  if n < 128: [list: n] else: link(num-modulo(n, 128) + 128, leb-u(num-quotient(n, 128))) end
end
fun sleb(n):
  byte = num-modulo(n, 128)
  rest = num-quotient(n, 128)
  done = ((rest == 0) and (byte < 64)) or ((rest == (0 - 1)) and (byte >= 64))
  if done: [list: byte] else: link(byte + 128, sleb(rest)) end
end
# TAIL-RECURSIVE list helpers — the prelude's `append`/`.append` are NON-tail (they recurse
# to the length of the receiver/first arg), so concatenating the large byte lists a big
# module produces overflows the WASM stack. These run in CONSTANT stack (the seed emits
# native tail calls), so module size no longer blows the stack.
fun rev-onto(xs, acc):
  cases(List) xs: | empty => acc | link(f, r) => rev-onto(r, link(f, acc)) end
end
fun tappend(a, b): rev-onto(rev-onto(a, empty), b) end   # a ++ b, tail-recursive
fun concat-bytes(lol):
  # accumulate all bytes in reverse (tail), then reverse once (tail).
  fun go(parts, acc):
    cases(List) parts: | empty => acc | link(f, r) => go(r, rev-onto(f, acc)) end
  end
  rev-onto(go(lol, empty), empty)
end
fun cat(parts): concat-bytes(parts) end
fun vec(items): append(leb-u(length(items)), concat-bytes(items)) end        # vector of pre-encoded items
fun byte-vec(bytes): append(leb-u(length(bytes)), bytes) end           # length-prefixed raw bytes
fun list-eq(a, b):
  cases(List) a: | empty => is-empty(b)
    | link(fa, ra) => cases(List) b: | empty => false | link(fb, rb) => (fa == fb) and list-eq(ra, rb) end end
end
fun index-of(env, nm):
  cases(List) env: | empty => raise("unbound") | link(f, r) => if list-eq(f, nm): 0 else: 1 + index-of(r, nm) end end
end

# ===== value types & heap types =====
i32t = [list: 127]
i64t = [list: 126]
f64t = [list: 124]
anyreft = [list: 110]
eqreft = [list: 109]
i31reft = [list: 108]
fun ref-null-t(ht): [list: 99, ht] end       # (ref null <typeidx ht>)
fun ref-t(ht): [list: 100, ht] end           # (ref <typeidx ht>)
# runtime.arr-facing aliases (shorter spellings used by runtime.arr / wasm-of-pyret.arr)
anyref = anyreft
fun reft(ht): ref-t(ht) end
fun reftnull(ht): ref-null-t(ht) end

# ===== type section: comptypes, subtyping, rec groups =====
# storage type = a value type (or packed i8=120 / i16=119 for arrays/struct fields)
i8st = [list: 120]
i16st = [list: 119]
fun field(storage-type, mut): append(storage-type, [list: mut]) end   # mut: 0 const, 1 var
fun struct-type(fields): append([list: 95], vec(fields)) end          # 95 = struct comptype
fun array-type(fld): append([list: 94], fld) end                      # 94 = array comptype
fun func-type(params, results):                                       # 96 = func comptype
  append([list: 96], append(byte-vec(params), byte-vec(results)))
end
# like func-type but params/results are List<valtype-byte-list> (each valtype may be
# multi-byte, e.g. a (ref null t)); counts entries, not bytes.
fun func-type-vt(params, results):
  append([list: 96], append(vec(params), vec(results)))
end
# subtype: 80 = sub (open) over a list of supertype indices, then the comptype.
fun sub-type(super-idxs, comptype): append([list: 80], append(vec(map(lam(i): [list: i] end, super-idxs)), comptype)) end
fun sub-final(super-idxs, comptype): append([list: 79], append(vec(map(lam(i): [list: i] end, super-idxs)), comptype)) end
fun rec-group(types): append([list: 78], vec(types)) end              # 78 = rec group

# ===== instructions =====
fun i32-const(n): link(65, sleb(n)) end
fun i64-const(n): link(66, sleb(n)) end
fun f64-const(x): link(68, f64-bits(x)) end
fun local-get(i): link(32, leb-u(i)) end
fun local-set(i): link(33, leb-u(i)) end
fun local-tee(i): link(34, leb-u(i)) end
fun global-get(i): link(35, leb-u(i)) end
fun global-set(i): link(36, leb-u(i)) end
i-drop = [list: 26]
i-end = [list: 11]
i-return = [list: 15]
i-unreachable = [list: 0]
# runtime.arr-facing aliases
end-instr = i-end
unreachable = i-unreachable
fun call(i): i-call(i) end
fun i-call(i): link(16, leb-u(i)) end
fun i-call-indirect(typeidx, tableidx): append([list: 17], append(leb-u(typeidx), leb-u(tableidx))) end
fun i-return-call(i): link(18, leb-u(i)) end
fun i-return-call-indirect(typeidx, tableidx): append([list: 19], append(leb-u(typeidx), leb-u(tableidx))) end
fun i-ref-null(ht): link(208, leb-u(ht)) end   # NB: heaptypes >=0 are typeidx; abstract use the negative encodings (TODO)
fun i-ref-func(i): link(210, leb-u(i)) end
ref-eq = [list: 211]                            # ref.eq : (eqref, eqref) -> i32  (0xD3)
ref-is-null = [list: 209]                       # ref.is_null : (ref null t) -> i32  (0xD1)
# control flow. blocktype: 64 = empty; a single value type list = that result type;
# a typeidx (sleb, non-negative) = a function-type block.
bt-empty = [list: 64]
fun bt-val(vt): vt end
fun i-if(bt): append([list: 4], bt) end
i-else = [list: 5]
fun i-block(bt): append([list: 2], bt) end
fun i-loop(bt): append([list: 3], bt) end
fun i-br(label): link(12, leb-u(label)) end
fun i-br-if(label): link(13, leb-u(label)) end

# GC ops (0xFB = 251 prefix). Type/field operands are leb-u typeidx / fieldidx.
fun gc(op, operands): append([list: 251], append(leb-u(op), concat-bytes(map(lam(o): leb-u(o) end, operands)))) end
fun struct-new(t): gc(0, [list: t]) end
fun struct-new-default(t): gc(1, [list: t]) end
fun struct-get(t, f): gc(2, [list: t, f]) end
fun struct-set(t, f): gc(5, [list: t, f]) end
fun array-new(t): gc(6, [list: t]) end
fun array-new-default(t): gc(7, [list: t]) end
fun array-new-fixed(t, n): gc(8, [list: t, n]) end
fun array-get(t): gc(11, [list: t]) end
fun array-get-s(t): gc(12, [list: t]) end   # packed (i8/i16) signed read
fun array-get-u(t): gc(13, [list: t]) end   # packed (i8/i16) unsigned read
fun array-set(t): gc(14, [list: t]) end
array-len = gc(15, [list: ])
# array.copy dst src : stack [dst, dst-off, src, src-off, len] (len on top)
fun array-copy(dst, src): gc(17, [list: dst, src]) end
fun ref-test(ht): gc(20, [list: ht]) end
fun ref-test-null(ht): gc(21, [list: ht]) end
fun ref-cast(ht): gc(22, [list: ht]) end       # ref.cast (ref ht)      = 0xFB 0x16
fun ref-cast-null(ht): gc(23, [list: ht]) end  # ref.cast (ref null ht) = 0xFB 0x17
ref-i31 = append([list: 251], leb-u(28))
i31-get-s = append([list: 251], leb-u(29))
i31-get-u = append([list: 251], leb-u(30))

# numeric opcodes (single bytes)
i32-eqz = [list: 69]  i32-eq = [list: 70]  i32-ne = [list: 71]
i32-lt-s = [list: 72]  i32-gt-s = [list: 74]  i32-le-s = [list: 76]  i32-ge-s = [list: 78]
i32-add = [list: 106]  i32-sub = [list: 107]  i32-mul = [list: 108]  i32-div-s = [list: 109]
i32-and = [list: 113]  i32-or = [list: 114]  i32-shl = [list: 116]  i32-shr-u = [list: 118]
i64-eqz = [list: 80]  i64-eq = [list: 81]  i64-ne = [list: 82]  i64-lt-s = [list: 83]  i64-gt-s = [list: 85]
i64-le-s = [list: 87]  i64-ge-s = [list: 89]
i-select = [list: 27]   # select : [a, b, cond:i32] -> a if cond else b
i64-add = [list: 124]  i64-sub = [list: 125]  i64-mul = [list: 126]  i64-div-s = [list: 127]
i64-rem-s = [list: 129]  i64-and = [list: 131]  i64-or = [list: 132]  i64-shl = [list: 134]  i64-shr-u = [list: 136]
f64-add = [list: 160]  f64-sub = [list: 161]  f64-mul = [list: 162]  f64-div = [list: 163]  f64-sqrt = [list: 159]
i32-wrap-i64 = [list: 167]
i64-extend-i32-s = [list: 172]  i64-extend-i32-u = [list: 173]
f64-convert-i64-s = [list: 185]  i64-trunc-f64-s = [list: 176]
i64-rem-u = [list: 130]  i64-div-u = [list: 128]
i64-extend-u-i32 = i64-extend-i32-u

# ===== linear-memory load/store (memarg = align ++ offset, both leb-u; we use offset 0).
# Mirrors runtime.ts's i32.store8/i32.load8_u (1-byte, align 0) and i32 word ops (align 2).
i32-load    = append([list: 40], [list: 2, 0])   # 0x28 align=2 offset=0
i32-store   = append([list: 54], [list: 2, 0])   # 0x36
i32-load8-u = append([list: 45], [list: 0, 0])   # 0x2D align=0
i32-store8  = append([list: 58], [list: 0, 0])   # 0x3A
# memory type (limits): flags 1 = min+max present, then min ++ max (pages).
fun mem-type(min, max): append([list: 1], append(leb-u(min), leb-u(max))) end

# ===== f64 IEEE-754 -> 8 little-endian bytes (for f64.const) =====
fun pow2(e): if e <= 0: 1 else: 2 * pow2(e - 1) end end
fun split-le(bits, i, sign):  # 8 little-endian bytes of the 63-bit magnitude `bits`,
  # OR-ing the sign into the high bit of the most-significant byte (index 7). `bits` stays
  # < 2^63 (fixnum-range) so num-modulo/num-quotient never hit the bignum path.
  if i == 8: empty
  else:
    base = num-modulo(num-quotient(bits, pow2(8 * i)), 256)
    byte = if i == 7: base + (sign * 128) else: base end
    link(byte, split-le(bits, i + 1, sign))
  end
end
fun norm-exp(ax, e):    # find e with 1 <= ax/2^e < 2  (ax > 0)
  if ax >= 2: norm-exp(ax / 2, e + 1)
  else if ax < 1: norm-exp(ax * 2, e - 1)
  else: e end
end
fun f64-bits(x):
  if x == 0: [list: 0, 0, 0, 0, 0, 0, 0, 0]   # +0.0 (TODO(port): -0.0, inf, nan, denormals)
  else:
    sign = if x < 0: 1 else: 0 end
    ax = num-abs(x)
    e = norm-exp(ax, 0)
    biased = e + 1023
    # scale ax into [1,2): pow2 only handles e>=0, so divide by 2^e for e>=0 and multiply by
    # 2^(-e) for e<0 (|x|<1). Both are exact in f64 (powers of two only shift the exponent).
    scaled = if e >= 0: ax / pow2(e) else: ax * pow2(0 - e) end
    frac = scaled - 1                       # in [0,1)
    # 52-bit mantissa. frac*2^52 is EXACTLY the integer mantissa (x has 52 mantissa bits, and
    # mul/div by powers of two is exact in f64) but is still a ROUGHNUM. num-to-rational converts
    # that integer-valued roughnum to an EXACT integer (it floors = identity here) — so the bytes
    # are exact. (num-floor keeps it rough, and num-modulo on a roughnum ref.cast-traps — the bug.)
    mant = num-to-rational(frac * pow2(52))
    # magnitude bits only (biased exponent + mantissa, < 2^63 = fixnum-range); the sign goes into
    # the top byte inside split-le, avoiding a 2^63 bignum (which traps split-le).
    magbits = (biased * pow2(52)) + mant
    split-le(magbits, 0, sign)
  end
end

# ===== wasm-module assembly =====
wasm-magic = [list: 0, 97, 115, 109, 1, 0, 0, 0]   # "\0asm" + version 1
fun section(id, content): link(id, append(leb-u(length(content)), content)) end
# Build a wasm-module from already-encoded section CONTENTS (each a byte list, or empty
# to omit). Section ids: 1 type, 2 import, 3 func, 4 table, 5 memory, 6 global,
# 7 export, 9 element, 10 code, 11 data.
fun wasm-module-of(type-c, import-c, func-c, table-c, mem-c, global-c, export-c, elem-c, code-c):
  fun s(id, c): if is-empty(c): empty else: section(id, c) end end
  concat-bytes([list:
    wasm-magic,
    s(1, type-c), s(2, import-c), s(3, func-c), s(4, table-c), s(5, mem-c),
    s(6, global-c), s(7, export-c), s(9, elem-c), s(10, code-c) ])
end
# code entry: vec(locals-decls) ++ body ++ end, wrapped length-prefixed.
fun local-decl(count, vt): append(leb-u(count), vt) end
fun code-entry(local-decls, body):
  # `body` is a whole function's instruction stream (can be large) — use tail-recursive
  # tappend so `body ++ end` doesn't recurse to body's length and overflow.
  byte-vec(tappend(vec(local-decls), tappend(body, i-end)))
end
# export entry: name (utf8 byte-vec) ++ kind(0 func/1 table/2 mem/3 global) ++ idx
fun str-bytes(s): string-to-code-points(s) end   # ASCII names only (TODO(port): real UTF-8)
fun export-entry(name, kind, idx): append(byte-vec(str-bytes(name)), append([list: kind], leb-u(idx))) end
# import entry: wasm-module ++ name (utf8) ++ kind ++ desc(typeidx for func)
fun import-func(mod, nm, typeidx):
  append(byte-vec(str-bytes(mod)), append(byte-vec(str-bytes(nm)), append([list: 0], leb-u(typeidx))))
end
# global: valtype ++ mut(0/1) ++ init-expr ++ end
fun global-entry(vt, mut, init): append(vt, append([list: mut], append(init, i-end))) end
# table: reftype ++ limits(0 ++ min). element seg (active, table 0): flags=0 ++ offset-expr ++ end ++ vec(funcidx)... use kind 0.
fun table-entry(reftype, min): append(reftype, append([list: 0], leb-u(min))) end
fun elem-active-funcs(offset, funcidxs):
  append([list: 0], append(offset, append(i-end, vec(map(lam(i): leb-u(i) end, funcidxs)))))
end
