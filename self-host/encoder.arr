#lang pyret
# PORT/sketch of the WASM-GC binary encoder — the binaryen replacement for the
# self-hosted compiler. Mirrors how runtime.ts + compile.ts build a module: it
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
  byte = num-modulo(n, 128)
  rest = num-quotient(n, 128)
  done = ((rest == 0) and (byte < 64)) or ((rest == (0 - 1)) and (byte >= 64))
  if done: [list: byte] else: link(byte + 128, sleb(rest)) end
end
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

# ---- module assembly ----
wasm-header = [list: 0, 97, 115, 109, 1, 0, 0, 0]   # \0asm version 1
# A function body: vec(locals-decls) ++ code ++ end, wrapped as a code entry (byte-vec).
fun code-entry(locals-decls :: List<List<Number>>, code :: List<Number>) -> List<Number>:
  byte-vec(vec(locals-decls).append(code).append(end-instr))
end
fun locals-decl(count :: Number, ty :: List<Number>) -> List<Number>: leb-u(count).append(ty) end

# Assemble a full module from prebuilt sections (caller builds type/import/func/table/
# global/export/element/code sections in order). TODO(port): a builder object that
# accumulates types/funcs/etc. and lays out indices, mirroring compile.ts's bookkeeping.
fun module(sections :: List<List<Number>>) -> List<Number>: wasm-header.append(concat(sections)) end
