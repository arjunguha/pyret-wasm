provide *
# Surface parser for the self-hosted compiler.
#
# NO JAVASCRIPT: this delegates to the pure-Pyret parser (self-host/
# pyret-parser.arr) — a hand-rolled tokenizer + recursive-descent parser written
# entirely in Pyret that parses the whole compiler closure (96/96 files) into real
# ast.arr ASTs with real srclocs. The deployable self-hosted compiler parses with
# no JS.
#
# `src` is the program text (the driver passes `read-source()`); `uri` is recorded
# as the source name in every srcloc.
#
# NAME-LOC CANONICALIZATION (temporary shim): the backend's free-variable analysis
# (self-host/wasm-of-pyret.arr `name-key`) keys variable identity by `tostring(name)`,
# which for `s-name` INCLUDES the srcloc — so with real srclocs a parameter's binding
# `s-name` differs from its use `s-name`, params get misclassified as free vars and
# captured as null (the driver doesn't run resolve-scope to assign atoms). We normalize
# ONLY `s-name` locs to dummy here, leaving real srclocs on every other node (good error
# locations).  Proper fix: make the backend use `A.Name.key()` (loc-independent) instead
# of `tostring`, then drop this shim.  (The old JS-GLR bridge — src/runtime/parse-bridge.ts
# + self-host/parse-from-tree.arr — stays for the seed/tests but is off the self-hosted path.)
import ast as A
import file("../../self-host/pyret-parser.arr") as PP

fun surface-parse(src-in, uri):
  # Parse `src-in`. Fall back to the host source buffer (`read-source()`) when given an
  # empty string — some callers/tests prime the runtime source and pass "" (the old
  # JS-GLR bridge ignored `src` entirely and always read the host buffer).
  src = if string-length(src-in) == 0: read-source() else: src-in end
  # Return the pure-Pyret parser's AST directly, with REAL srclocs — no JS, no shim.
  # (We used to `.visit(A.dummy-loc-visitor)` to canonicalize `s-name` locs because the
  # backend's free-var `name-key` keyed on `tostring(name)` (loc-sensitive). The backend
  # now keys on `A.Name.key()` (loc-independent), so the shim is unnecessary — and it
  # was itself trapping on `a-app` annotation nodes in the large compiler modules.)
  PP.parse-named(src, uri)
end
