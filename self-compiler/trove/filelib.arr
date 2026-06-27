provide *
# Pyret stub for the JS-only `filelib` trove module. Used (via file.arr) only by the
# compiler's DRIVER / JS-backend modules (compile-lib, repl, js-of-pyret) — not by core
# compilation — so stub bodies suffice to make those modules COMPILE in the WASM build.
# Real file IO, if ever needed, comes through the host, not here.
# (Mirrors the source-map-lib / pathlib / type-logger / sha shim approach.)

fun open-input-file(path :: String): 0 end
fun open-output-file(path :: String, append): 0 end
fun read-file(f): "" end
fun file-to-string(path :: String): "" end
fun close-input-file(f): nothing end
fun close-output-file(f): nothing end
fun flush-output-file(f): nothing end
fun display(f, s): nothing end
fun file-times(f): { mtime: 0, atime: 0, ctime: 0 } end
fun exists(path :: String): false end
fun is-file(path :: String): false end
fun is-dir(path :: String): false end
fun list-files(path :: String): [list: ] end
fun real-path(path :: String): path end
