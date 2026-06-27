<<<<<<< HEAD
provide *
# WASM-GC binary encoder, written in Pyret — the binaryen replacement for the
# self-hosted compiler. Mirrors the byte sequences src/compiler/{types,runtime,
# compile}.ts produce via binaryen. Lists of bytes (0..255) are the unit of output;
# `concat`/`append` join them; sections wrap them. NOT yet run end-to-end.
#
# Opcode references (from the seed's emitted .wat / binaryen disassembly):
#   value types: i32=127 i64=126 f64=124 v128=123 funcref=112 externref=111
#                anyref=110 eqref=109 i31ref=108 structref=107 arrayref=106
#   (ref null ht)=99,ht   (ref ht)=100,ht
#   comptypes: func=96 struct=95 array=94 ; sub=80 sub-final=79? ; rec-group=78
#   GC ops (prefix 0xFB=251): struct.new=0 struct.new_default=1 struct.get=2
#     struct.get_s=3 struct.get_u=4 struct.set=5 array.new=6 array.new_default=7
#     array.new_fixed=8 array.get=11 array.get_s=12 array.get_u=13 array.set=14
#     array.len=15 ref.test=20 ref.test_null=21 ref.cast=23 ref.cast_null=24
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
=======
#lang pyret
# PORT/sketch of the WASM-GC binary encoder — the binaryen replacement for the
# self-hosted compiler. Mirrors how runtime.ts + compile.ts build a wasm-module: it
# produces raw WASM bytes (List<Number>, 0..255). compile.arr calls these emitters
# instead of binaryen's `m.*` builders.
#
# SKETCH STATUS: LEB128 + sections are faithful (adapted from selfhost/encoder.arr,
# already exercised). Instruction/type encoders cover the opcodes compile.ts uses;
# TODO(port) marks any gaps to fill when wiring compile.arr.
#
# Opcode references (learned via binaryen disassembly, see project memory):
#   anyref=110 i31ref=108 ; ref.test=[251,21,ht] ref.cast=[251,23,ht]
#   ref.i31=[251,28] i31.get_s=[251,29] ref.null=[208,ht]
#   struct.new=251,0,T struct.get=251,2,T,F ; array.new_fixed=251,8,T,n
#   array.new_default=251,7,T array.get=251,11,T array.set=251,14,T array.len=251,15
#   call=16 call_indirect=17 return_call_indirect=19 ; i64 add=124 sub=125 mul=126
#   i64.lt_s=83 i64.shr_u=136 i64.shl=134 i64.extend_i32_u=173 i32.wrap=167 i64.div_s=127
#   rec group=78 struct comptype=95 array comptype=94 ; if=4 block=2 loop=3 br=12 br_if=13

provide *

# ---- LEB128 + vectors + sections (faithful; from selfhost/encoder.arr) ----
fun leb-u(n :: Number) -> List<Number>:
  if n < 128: [list: n]
  else: link(num-modulo(n, 128) + 128, leb-u(num-quotient(n, 128))) end
end
fun sleb(n :: Number) -> List<Number>:
>>>>>>> worktree-agent-a949a57b5fe48e7c9
  byte = num-modulo(n, 128)
  rest = num-quotient(n, 128)
  done = ((rest == 0) and (byte < 64)) or ((rest == (0 - 1)) and (byte >= 64))
  if done: [list: byte] else: link(byte + 128, sleb(rest)) end
end
<<<<<<< HEAD
fun concat(lol):
  cases(List) lol: | empty => empty | link(f, r) => append(f, concat(r)) end
end
fun cat(parts): concat(parts) end
fun vec(items): append(leb-u(length(items)), concat(items)) end        # vector of pre-encoded items
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
fun i-call(i): link(16, leb-u(i)) end
fun i-call-indirect(typeidx, tableidx): append([list: 17], append(leb-u(typeidx), leb-u(tableidx))) end
fun i-return-call(i): link(18, leb-u(i)) end
fun i-return-call-indirect(typeidx, tableidx): append([list: 19], append(leb-u(typeidx), leb-u(tableidx))) end
fun i-ref-null(ht): link(208, leb-u(ht)) end   # NB: heaptypes >=0 are typeidx; abstract use the negative encodings (TODO)
fun i-ref-func(i): link(210, leb-u(i)) end
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
fun gc(op, operands): append([list: 251], append(leb-u(op), concat(map(lam(o): leb-u(o) end, operands)))) end
fun struct-new(t): gc(0, [list: t]) end
fun struct-new-default(t): gc(1, [list: t]) end
fun struct-get(t, f): gc(2, [list: t, f]) end
fun struct-set(t, f): gc(5, [list: t, f]) end
fun array-new(t): gc(6, [list: t]) end
fun array-new-default(t): gc(7, [list: t]) end
fun array-new-fixed(t, n): gc(8, [list: t, n]) end
fun array-get(t): gc(11, [list: t]) end
fun array-set(t): gc(14, [list: t]) end
fun array-len(): gc(15, [list: ]) end
fun ref-test(ht): gc(20, [list: ht]) end
fun ref-test-null(ht): gc(21, [list: ht]) end
fun ref-cast(ht): gc(23, [list: ht]) end
fun ref-cast-null(ht): gc(24, [list: ht]) end
ref-i31 = append([list: 251], leb-u(28))
i31-get-s = append([list: 251], leb-u(29))
i31-get-u = append([list: 251], leb-u(30))

# numeric opcodes (single bytes)
i32-eqz = [list: 69]  i32-eq = [list: 70]  i32-ne = [list: 71]
i32-lt-s = [list: 72]  i32-gt-s = [list: 74]  i32-le-s = [list: 76]  i32-ge-s = [list: 78]
i32-add = [list: 106]  i32-sub = [list: 107]  i32-mul = [list: 108]  i32-div-s = [list: 109]
i32-and = [list: 113]  i32-or = [list: 114]  i32-shl = [list: 116]  i32-shr-u = [list: 118]
i64-eqz = [list: 80]  i64-eq = [list: 81]  i64-lt-s = [list: 83]  i64-gt-s = [list: 85]
i64-le-s = [list: 87]  i64-ge-s = [list: 89]
i64-add = [list: 124]  i64-sub = [list: 125]  i64-mul = [list: 126]  i64-div-s = [list: 127]
i64-rem-s = [list: 129]  i64-and = [list: 131]  i64-or = [list: 132]  i64-shl = [list: 134]  i64-shr-u = [list: 136]
f64-add = [list: 160]  f64-sub = [list: 161]  f64-mul = [list: 162]  f64-div = [list: 163]  f64-sqrt = [list: 159]
i32-wrap-i64 = [list: 167]
i64-extend-i32-s = [list: 172]  i64-extend-i32-u = [list: 173]
f64-convert-i64-s = [list: 185]  i64-trunc-f64-s = [list: 176]

# ===== f64 IEEE-754 -> 8 little-endian bytes (for f64.const) =====
fun pow2(e): if e <= 0: 1 else: 2 * pow2(e - 1) end end
fun split-le(bits, i):  # 8 little-endian bytes of a 64-bit integer `bits`
  if i == 8: empty else: link(num-modulo(num-quotient(bits, pow2(8 * i)), 256), split-le(bits, i + 1)) end
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
    frac = (ax / pow2(e)) - 1               # in [0,1)
    mant = num-floor(frac * pow2(52))       # 52-bit mantissa (TODO(port): round-to-nearest-even)
    bits = ((sign * pow2(63)) + (biased * pow2(52))) + mant
    split-le(bits, 0)
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
  concat([list:
    wasm-magic,
    s(1, type-c), s(2, import-c), s(3, func-c), s(4, table-c), s(5, mem-c),
    s(6, global-c), s(7, export-c), s(9, elem-c), s(10, code-c) ])
end
# code entry: vec(locals-decls) ++ body ++ end, wrapped length-prefixed.
fun local-decl(count, vt): append(leb-u(count), vt) end
fun code-entry(local-decls, body):
  byte-vec(append(vec(local-decls), append(body, i-end)))
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
=======
fun concat(lol :: List<List<Number>>) -> List<Number>:
  cases(List) lol: | empty => empty | link(f, r) => f.append(concat(r)) end
end
fun vec(items :: List<List<Number>>) -> List<Number>: leb-u(items.length()).append(concat(items)) end
fun byte-vec(bytes :: List<Number>) -> List<Number>: leb-u(bytes.length()).append(bytes) end
fun section(id :: Number, content :: List<Number>) -> List<Number>:
  link(id, leb-u(content.length()).append(content))
end

# ---- value types / heap types ----
i32t   = [list: 127]
i64t   = [list: 126]
f64t   = [list: 124]
anyref = [list: 110]
i31ref = [list: 108]
fun reftnull(idx :: Number) -> List<Number>: [list: 99, idx] end   # (ref null idx)
fun reft(idx :: Number) -> List<Number>: [list: 100, idx] end       # (ref idx)
fun functype(params :: List<List<Number>>, results :: List<List<Number>>) -> List<Number>:
  [list: 96].append(vec(params)).append(vec(results))
end

# ---- GC composite types (in rec groups) ----
# struct comptype: 95, field-count, (storagetype, mut)* ; array comptype: 94, storagetype, mut
fun struct-type(fields :: List<List<Number>>) -> List<Number>: link(95, vec(fields)) end
fun array-type(storage :: List<Number>, mutable :: Boolean) -> List<Number>:
  [list: 94].append(storage).append([list: if mutable: 1 else: 0 end])
end
fun field(ty :: List<Number>, mutable :: Boolean) -> List<Number>: ty.append([list: if mutable: 1 else: 0 end]) end
fun rec-group(types :: List<List<Number>>) -> List<Number>: link(78, vec(types)) end

# ---- instructions (emit raw bytes) ----
fun i32-const(n :: Number) -> List<Number>: link(65, sleb(n)) end       # 0x41
fun i64-const(n :: Number) -> List<Number>: link(66, sleb(n)) end       # 0x42
# f64.const = 0x44 + 8 little-endian bytes. TODO(port): IEEE-754 bit encoding helper.
fun f64-const-bits(le8 :: List<Number>) -> List<Number>: link(68, le8) end
fun local-get(i :: Number) -> List<Number>: link(32, leb-u(i)) end
fun local-set(i :: Number) -> List<Number>: link(33, leb-u(i)) end
fun local-tee(i :: Number) -> List<Number>: link(34, leb-u(i)) end
fun global-get(i :: Number) -> List<Number>: link(35, leb-u(i)) end
fun global-set(i :: Number) -> List<Number>: link(36, leb-u(i)) end
fun call(i :: Number) -> List<Number>: link(16, leb-u(i)) end
fun call-indirect(typeidx :: Number, tableidx :: Number) -> List<Number>:
  link(17, leb-u(typeidx).append(leb-u(tableidx)))
end
fun return-call-indirect(typeidx :: Number, tableidx :: Number) -> List<Number>:
  link(19, leb-u(typeidx).append(leb-u(tableidx)))
end
drop-instr = [list: 26]                          # 0x1A
unreachable = [list: 0]
# i64 arithmetic / compare
i64-add = [list: 124]  i64-sub = [list: 125]  i64-mul = [list: 126]  i64-div-s = [list: 127]
i64-lt-s = [list: 83]  i64-eq = [list: 81]  i64-shl = [list: 134]  i64-shr-u = [list: 136]
i64-extend-i32-u = [list: 173]  i32-wrap-i64 = [list: 167]
i32-add = [list: 106]  i32-sub = [list: 107]  i32-mul = [list: 108]  i32-eqz = [list: 69]
f64-add = [list: 160]  f64-sub = [list: 161]  f64-mul = [list: 162]  f64-div = [list: 163]  f64-sqrt = [list: 159]
# GC ops
fun struct-new(ty :: Number) -> List<Number>: [list: 251, 0, ty] end
fun struct-get(ty :: Number, fld :: Number) -> List<Number>: [list: 251, 2, ty, fld] end
fun struct-set(ty :: Number, fld :: Number) -> List<Number>: [list: 251, 5, ty, fld] end
fun array-new-fixed(ty :: Number, n :: Number) -> List<Number>: [list: 251, 8, ty].append(leb-u(n)) end
fun array-new-default(ty :: Number) -> List<Number>: [list: 251, 7, ty] end
fun array-get(ty :: Number) -> List<Number>: [list: 251, 11, ty] end
fun array-set(ty :: Number) -> List<Number>: [list: 251, 14, ty] end
array-len = [list: 251, 15]
fun ref-test(ht :: Number) -> List<Number>: [list: 251, 21, ht] end
fun ref-cast(ht :: Number) -> List<Number>: [list: 251, 23, ht] end
ref-i31 = [list: 251, 28]
i31-get-s = [list: 251, 29]
fun ref-null(ht :: Number) -> List<Number>: [list: 208, ht] end
# control flow (blocktype: 64 = empty, or a value type byte, or sleb typeidx)
fun if-instr(blocktype :: List<Number>) -> List<Number>: link(4, blocktype) end
fun block-instr(blocktype :: List<Number>) -> List<Number>: link(2, blocktype) end
fun loop-instr(blocktype :: List<Number>) -> List<Number>: link(3, blocktype) end
else-instr = [list: 5]
end-instr = [list: 11]
fun br(depth :: Number) -> List<Number>: link(12, leb-u(depth)) end
fun br-if(depth :: Number) -> List<Number>: link(13, leb-u(depth)) end

# ---- wasm-module assembly ----
wasm-header = [list: 0, 97, 115, 109, 1, 0, 0, 0]   # \0asm version 1
# A function body: vec(locals-decls) ++ code ++ end, wrapped as a code entry (byte-vec).
fun code-entry(locals-decls :: List<List<Number>>, code :: List<Number>) -> List<Number>:
  byte-vec(vec(locals-decls).append(code).append(end-instr))
end
fun locals-decl(count :: Number, ty :: List<Number>) -> List<Number>: leb-u(count).append(ty) end

# Assemble a full wasm-module from prebuilt sections (caller builds type/import/func/table/
# global/export/element/code sections in order). TODO(port): a builder object that
# accumulates types/funcs/etc. and lays out indices, mirroring compile.ts's bookkeeping.
fun wasm-module(sections :: List<List<Number>>) -> List<Number>: wasm-header.append(concat(sections)) end
>>>>>>> worktree-agent-a949a57b5fe48e7c9
