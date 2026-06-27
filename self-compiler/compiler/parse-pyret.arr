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
  # `.visit(dummy-loc-visitor)` normalizes ALL locs to dummy. We must dummy not just
  # `s-name` uses but every loc the DRIVER later copies into a freshly-created `s-name`
  # (e.g. desugaring `fun f` → an `s-letrec-bind` whose binder name reuses the s-fun's
  # loc): otherwise the driver-made binder name (real loc) ≠ the canonicalized use name
  # (dummy loc) and the backend's `tostring`-keyed free-var analysis mis-binds it.
  # pyret-parser still produces REAL srclocs (its own tests rely on them); this shim
  # only normalizes the AST handed to the backend, until the backend keys names by
  # `A.Name.key()` instead of `tostring`.
  PP.parse-named(src, uri).visit(A.dummy-loc-visitor)
end
