provide *
# WASM binary encoder + small list helpers, written in Pyret.
# Part of the single self-hosted Pyret->WASM compiler (see compiler.arr).

fun leb-u(n):
  if n < 128: [list: n] else: link(num-modulo(n, 128) + 128, leb-u(num-quotient(n, 128))) end
end
fun sleb(n):
  byte = num-modulo(n, 128)
  rest = num-quotient(n, 128)
  done = ((rest == 0) and (byte < 64)) or ((rest == (0 - 1)) and (byte >= 64))
  if done: [list: byte] else: link(byte + 128, sleb(rest)) end
end
fun concat(lol):
  cases(List) lol: | empty => empty | link(f, r) => append(f, concat(r)) end
end
fun vec(items): append(leb-u(length(items)), concat(items)) end
fun byte-vec(bytes): append(leb-u(length(bytes)), bytes) end
fun section(id, content): link(id, append(leb-u(length(content)), content)) end
fun functype(params, results): append([list: 96], append(byte-vec(params), byte-vec(results))) end
fun list-eq(a, b):
  cases(List) a: | empty => is-empty(b)
    | link(fa, ra) => cases(List) b: | empty => false | link(fb, rb) => (fa == fb) and list-eq(ra, rb) end end
end
fun index-of(env, nm):
  cases(List) env: | empty => raise("unbound") | link(f, r) => if list-eq(f, nm): 0 else: 1 + index-of(r, nm) end end
end
