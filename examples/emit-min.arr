# A Pyret program that EMITS a WebAssembly module (byte by byte) using the
# `emit-byte` primitive. This is the seed of the self-hosting WASM encoder:
# Pyret (compiled to WASM by our seed) producing WASM that the host can run.
#
# The emitted module exports `f : -> i32` returning 42.

fun eb(n): emit-byte(n) end

fun emit-all(bytes):
  each(eb, bytes)
end

emit-all([list:
  # magic + version
  0, 97, 115, 109,   1, 0, 0, 0,
  # type section: one type () -> i32
  1, 5, 1,   96, 0, 1, 127,
  # function section: function 0 has type 0
  3, 2, 1, 0,
  # export section: export "f" as function 0
  7, 5, 1,   1, 102,   0, 0,
  # code section: one body -> (i32.const 42)
  10, 6, 1,   4, 0,   65, 42,   11
])
