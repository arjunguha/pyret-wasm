# A real (small) WASM binary encoder written IN PYRET, with automatic size
# computation. Builds byte LISTS and length-prefixes sections/vectors, then emits
# the whole module. Compiled to WASM by the seed; the host runs the result.
# This is the structural core the self-hosting codegen will grow from.

fun eb(n): emit-byte(n) end

# unsigned LEB128 -> list of bytes
fun leb-u(n):
  if n < 128: [list: n]
  else: link(num-modulo(n, 128) + 128, leb-u(num-quotient(n, 128)))
  end
end

# signed LEB128 -> list of bytes
fun sleb(n):
  byte = num-modulo(n, 128)
  rest = num-quotient(n, 128)
  done = ((rest == 0) and (byte < 64)) or ((rest == (0 - 1)) and (byte >= 64))
  if done: [list: byte]
  else: link(byte + 128, sleb(rest))
  end
end

# flatten a list of byte-lists
fun concat(lol):
  cases(List) lol:
    | empty => empty
    | link(f, r) => append(f, concat(r))
  end
end

# a vector: count (LEB) followed by the concatenated elements (each a byte-list)
fun vec(items): append(leb-u(length(items)), concat(items)) end

# a vector of raw bytes (e.g. a name): count (LEB) followed by the bytes
fun byte-vec(bytes): append(leb-u(length(bytes)), bytes) end

# a section: id byte, then byte-length (LEB) of the content, then content
fun section(id, content): link(id, append(leb-u(length(content)), content)) end

# ---- build a module: () -> i32 returning 7777 ----
functype = [list: 96, 0, 1, 127]                  # 0x60, 0 params, 1 result i32
type-sec = section(1, vec([list: functype]))
func-sec = section(3, vec([list: [list: 0]]))      # function 0 : type 0
export-f = append(byte-vec([list: 102]), [list: 0, 0])  # name "f", kind func, idx 0
export-sec = section(7, vec([list: export-f]))
code = concat([list: [list: 65], sleb(7777), [list: 11]])  # i32.const 7777; end
body = append(vec(empty), code)                    # 0 locals, then code
code-sec = section(10, vec([list: append(leb-u(length(body)), body)]))

mod = concat([list:
  [list: 0, 97, 115, 109,  1, 0, 0, 0],            # magic + version
  type-sec, func-sec, export-sec, code-sec ])

each(eb, mod)
