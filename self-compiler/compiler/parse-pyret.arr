provide *
# Surface parser for the self-hosted compiler. The real Pyret surface syntax is
# parsed by the seed's JS GLR tokenizer+parser; that CST is lowered host-side
# (src/runtime/parse-bridge.ts) and rebuilt into ast.arr AST by parse-from-tree.
#
# NOTE (current scope): the host bridge parses the RUNTIME source buffer (what
# `read-source` delivers) — lazily, the first time the parser walks it — so `src`
# must be that same program. surface-parse does not yet parse an arbitrary string
# independent of read-source: transmitting `src` to the host needs a string-passing
# parse intrinsic in the seed (src/compiler/compile.ts), a one-line follow-up.
# Forms wired: program/block, num/str/bool/id, binop, app, dot, method-call, if/
# if-else, let/var, fun/lam, [list: ...] construct, and `is` check-tests. Growing
# coverage means growing parse-bridge.ts + parse-from-tree.arr together.
import file("../../self-host/parse-from-tree.arr") as PT

fun surface-parse(src, uri):
  PT.from-tree()
end
