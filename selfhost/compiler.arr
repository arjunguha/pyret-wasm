# The single self-hosted Pyret -> WebAssembly compiler, modularized.
#
# Pieces (each its own .arr, brought in whole-program by the seed's multi-file
# loader): encoder / ast / lexer / parser / codegen. The seed compiles this whole
# thing into compiler.wasm. The SELF-HOSTING GOAL is the fixpoint: compiler.wasm
# compiling THIS source must reproduce itself byte-for-byte (compiler2.wasm), and
# that fixpoint compiler is what the CLI/web/tests/benchmarks use.
#
# Current coverage is a bounded subset (fun/if/let/calls/recursion, i32 arithmetic);
# reaching the fixpoint requires growing it to every feature this source itself
# uses (data/cases, lists, strings, ...). See scripts/selfhost-fixpoint.ts.

include file("./encoder.arr")
include file("./ast.arr")
include file("./lexer.arr")
include file("./parser.arr")
include file("./codegen.arr")

fun compile-source(src):
  compile-prog(parse-prog(lex(string-to-code-points(src))))
end

fun eb(n): emit-byte(n) end
each(eb, compile-source(read-source()))
