# Self-hosting building block: signed LEB128 encoding computed IN PYRET, used to
# emit a WASM module whose function returns 1000 (a 2-byte LEB128 operand 0xE8 0x07).

fun eb(n): emit-byte(n) end
fun emit-all(bs): each(eb, bs) end

# Signed LEB128 of an integer, emitted low-byte first.
fun sleb(n):
  byte = num-modulo(n, 128)
  rest = num-quotient(n, 128)
  done = ((rest == 0) and (byte < 64)) or ((rest == (0 - 1)) and (byte >= 64))
  if done:
    emit-byte(byte)
  else:
    emit-byte(byte + 128)
    sleb(rest)
  end
end

# header + type () -> i32 + function 0 + export "f"
emit-all([list: 0, 97, 115, 109,  1, 0, 0, 0,
                1, 5, 1, 96, 0, 1, 127,
                3, 2, 1, 0,
                7, 5, 1, 1, 102, 0, 0])
# code section: id=10 size=7 count=1 bodysize=5 locals=0 i32.const(0x41) <LEB> end(0x0b)
emit-all([list: 10, 7, 1, 5, 0, 65])
sleb(1000)
emit-byte(11)
