#lang pyret
# PORT (structural sketch) of src/compiler/compile.ts — the Pyret->WASM codegen,
# written in Pyret. Consumes the CST (name/kids/value tree from the reused parser)
# and emits a WASM module via encoder.arr (the binaryen replacement). The seed
# compiles THIS into compiler.wasm; the fixpoint is compiler.wasm compiling its own
# source to a byte-identical compiler.
#
# ===== PORT NOTES =====
# Faithfully ported (structure 1:1 with compile.ts):
#   - CST helpers: only / child-named / binding-name / header-param-bindings
#   - the compile-expr DISPATCH (every node.name case compile.ts handles)
#   - compile-app intrinsic table + the closure calling convention
#   - the 3-pass compile-program shape (register globals -> compile fns -> $main)
#   - closure model ($Closure {fnIndex, caps} + function table + return_call_indirect)
#   - var boxing for captured-and-mutated vars; tuple-binding destructuring
# Stubbed (TODO(port) — bodies emit via encoder.arr, filled when wiring/debugging):
#   - the actual byte sequences for each expr (call into encoder ops)
#   - the number tower / runtime emission (lives in runtime.arr)
#   - data/cases variant layout + method tables, objects, extend
# Diverged from compile.ts: uses a Ctx data value threaded explicitly (Pyret has no
#   `this`); binaryen `m.*` calls become encoder.arr emitters returning List<Number>.
# Biggest debugging risks later: (1) exact byte encodings vs binaryen; (2) the GC
#   rec-group/type indices matching runtime.arr; (3) tail-call (return_call_indirect)
#   type indices; (4) value-model tag bytes (i31 for bool/nothing).

provide *
import encoder as E
# TODO(port): import the shared CstNode type + the prelude source (prelude.arr).
data CstNode: cst(name :: String, value :: Option<String>, kids :: List<CstNode>) end

# ---- value-model type indices (must match runtime.arr's rec groups / types.ts) ----
# $Num=0 $Fixnum=1 $Rational=2 $Roughnum=3 $Bignum=4 ; $Str ; $Fields $Variant $Closure ; $Object ...
# TODO(port): a Types record built once (mirror types.ts buildTypes) and threaded.

# ---- compilation context (replaces compile.ts's Ctx class + `this`) ----
data Ctx: ctx(
    top :: Boolean,
    locals :: List<String>,        # name -> local index (use index-of)
    params :: List<String>,
    captures :: List<String>,
    boxed :: List<String>,          # captured-and-mutated vars (stored in 1-cell arrays)
    local-types :: List<List<Number>>) # wasm types of declared locals
end
fun fresh-ctx(top :: Boolean) -> Ctx: ctx(top, empty, empty, empty, empty, empty) end

# ---- CST helpers (mirror only/childNamed/bindingName/headerParamBindings) ----
fun only(n :: CstNode) -> CstNode:
  if n.kids.length() == 1: n.kids.first else: raise("expected single child of " + n.name) end
end
fun child-named(n :: CstNode, nm :: String) -> Option<CstNode>:
  find(lam(k): k.name == nm end, n.kids)
end
fun binding-name(binding :: CstNode) -> String:
  fun loop(b :: CstNode):
    if (b.name == "toplevel-binding") or (b.name == "binding") or (b.name == "name-binding"):
      cases(Option) child-named(b, "NAME"):
        | some(nm) => nm.value.or-else("_") | none => loop(b.kids.first) end
    else: raise("could not extract binding name") end
  end
  loop(binding)
end
# tuple-binding aware (mirror bindingNames/tupleComponents): flatten {a; b} bindings.
fun binding-names(binding :: CstNode) -> List<String>:
  # TODO(port): detect tuple-binding and recurse into components; for now single name.
  [list: binding-name(binding)]
end
fun header-param-bindings(fn-like :: CstNode) -> List<CstNode>:
  cases(Option) child-named(fn-like, "fun-header"):
    | none => empty
    | some(h) => cases(Option) child-named(h, "args"):
        | none => empty | some(a) => filter(lam(k): k.name == "binding" end, a.kids) end
  end
end

# ===== expressions: the central dispatch (mirror compileExpr's switch) =====
# Each arm returns the WASM bytes (List<Number>) that leave the expr's value on the
# stack. `tail` enables return_call_indirect for proper tail calls.
fun compile-expr(node :: CstNode, c :: Ctx, tail :: Boolean) -> List<Number>:
  ask:
    | (node.name == "check-test") or (node.name == "expr") or (node.name == "prim-expr") then:
      compile-expr(only(node), c, tail)
    | node.name == "binop-expr" then:
      if node.kids.length() == 1: compile-expr(node.kids.first, c, tail) else: compile-binop(node, c) end
    | node.name == "paren-expr" then: compile-expr(child-named(node, "binop-expr").value, c, tail)
    | node.name == "app-expr" then: compile-app(node, c, tail)
    | node.name == "lambda-expr" then: compile-lambda(node, c)
    | node.name == "id-expr" then: resolve-name(only(node).value.or-else("_"), c)
    | node.name == "cases-expr" then: compile-cases(node, c, tail)
    | node.name == "num-expr" then: compile-number(only(node).value.or-else("0"))
    | node.name == "frac-expr" then: compile-rational(only(node).value.or-else("0/1"), false)
    | node.name == "rfrac-expr" then: compile-rational(only(node).value.or-else("0/1"), true)
    | node.name == "bool-expr" then: E.ref-i31.append(E.i32-const(if only(node).name == "TRUE": 1 else: 0 end))
    | node.name == "string-expr" then: compile-string(only(node).value.or-else(""))
    | node.name == "if-expr" then: compile-if(node, c, tail)
    | node.name == "construct-expr" then: compile-construct(node, c)
    | node.name == "obj-expr" then: compile-object(node, c)
    | node.name == "dot-expr" then: compile-dot(node, c)
    | node.name == "for-expr" then: compile-for(node, c, tail)
    | node.name == "user-block-expr" then: compile-block(child-named(node, "block").value, c, tail)
    | node.name == "inst-expr" then: compile-expr(node.kids.first, c, tail)   # generic inst erased
    | node.name == "tuple-expr" then: compile-tuple(node, c)
    | node.name == "tuple-get" then: compile-tuple-get(node, c)
    | node.name == "assign-expr" then: compile-assign(node, c)
    | node.name == "extend-expr" then: compile-extend(node, c)   # obj.{f: v}
    | node.name == "template-expr" then: E.call(idx-raise-template())  # `...` -> raise
    | otherwise: raise("unsupported expression: " + node.name)
  end
end

# ===== application: intrinsics vs closure call (mirror compileApp) =====
# Intrinsic names handled directly (MUST match cps.arr INTRINSICS + the real list).
intrinsics :: List<String> = [list:
  "raise", "print", "display", "print-error", "tostring", "torepr", "identical",
  "string-length", "string-to-code-points", "string-from-code-point",
  "num-modulo", "num-quotient", "num-to-string", "num-sqrt", "num-expt",
  "is-string", "is-number", "is-boolean", "is-function", "is-object",
  "raw-array-get", "raw-array-set", "raw-array-length", "raw-array-of",
  "equal-always", "equal-now", "emit-byte", "read-source",
  "yield-check", "finish-result" ]
fun compile-app(node :: CstNode, c :: Ctx, tail :: Boolean) -> List<Number>:
  fn-node = node.kids.first
  arg-nodes = app-arg-nodes(node)
  cases(Option) simple-name(fn-node):
    | some(name) =>
      if intrinsics.member(name): compile-intrinsic(name, arg-nodes, c, tail)
      else if is-module-member-call(node): compile-module-call(node, c, tail)
      else: call-closure-value(resolve-name(name, c), arg-nodes, c, tail) end
    | none =>
      # could be a dot/method call, or a computed callee
      compile-general-call(fn-node, arg-nodes, c, tail)
  end
end
# TODO(port): bodies. compile-intrinsic emits the op for each builtin (e.g. raise ->
# call $raise import; raw-array-get -> array.get; num-* -> runtime calls). Mirror the
# big `if (name === ...)` ladder in compile.ts compileApp.
fun compile-intrinsic(name :: String, args :: List<CstNode>, c :: Ctx, tail :: Boolean) -> List<Number>:
  raise("TODO(port): intrinsic " + name)
end
fun compile-general-call(fn-node, args, c, tail) -> List<Number>: raise("TODO(port): general/method call") end
fun compile-module-call(node, c, tail) -> List<Number>: raise("TODO(port): N.member(...) call") end
fun is-module-member-call(node :: CstNode) -> Boolean: false end   # TODO(port)

# closure calling convention: $Closure{fnIndex, caps}; call via (return_)call_indirect
# on the function table with sig (closure, fields). (mirror callClosureValue)
fun call-closure-value(closure-bytes :: List<Number>, args :: List<CstNode>, c :: Ctx, tail :: Boolean) -> List<Number>:
  raise("TODO(port): pack args into $Fields, struct.get fnIndex, " +
        (if tail: "return_call_indirect" else: "call_indirect" end))
end

# ===== other expression compilers (signatures mirror compile.ts) =====
fun compile-binop(node :: CstNode, c :: Ctx) -> List<Number>: raise("TODO(port): compile-binop ($plus/$equal dispatch)") end
fun compile-if(node :: CstNode, c :: Ctx, tail :: Boolean) -> List<Number>: raise("TODO(port): if -> nested if-instr, tail through branches") end
fun compile-cases(node :: CstNode, c :: Ctx, tail :: Boolean) -> List<Number>: raise("TODO(port): cases -> vtag dispatch + branch binds") end
fun compile-block(block :: CstNode, c :: Ctx, tail :: Boolean) -> List<Number>: raise("TODO(port): block stmts, last is tail") end
fun compile-lambda(node :: CstNode, c :: Ctx) -> List<Number>: raise("TODO(port): build closure from params+body, capture free vars") end
fun compile-construct(node :: CstNode, c :: Ctx) -> List<Number>: raise("TODO(port): [ctor: ...] -> ctor.make([raw-array: ...])") end
fun compile-object(node :: CstNode, c :: Ctx) -> List<Number>: raise("TODO(port): $Object {names, values}") end
fun compile-dot(node :: CstNode, c :: Ctx) -> List<Number>: raise("TODO(port): field access by name (runtime variant-layout dispatch) / method") end
fun compile-extend(node :: CstNode, c :: Ctx) -> List<Number>: raise("TODO(port): obj.{f:v} -> $obj_extend") end
fun compile-for(node :: CstNode, c :: Ctx, tail :: Boolean) -> List<Number>: raise("TODO(port): for -> HOF call") end
fun compile-tuple(node :: CstNode, c :: Ctx) -> List<Number>: raise("TODO(port): tuple variant id 0") end
fun compile-tuple-get(node :: CstNode, c :: Ctx) -> List<Number>: raise("TODO(port): tuple .{n}") end
fun compile-assign(node :: CstNode, c :: Ctx) -> List<Number>: raise("TODO(port): := local/global/box set") end
fun compile-number(lit :: String) -> List<Number>: raise("TODO(port): parse int/bignum -> $make_fix / $make_big") end
fun compile-rational(lit :: String, rough :: Boolean) -> List<Number>: raise("TODO(port): a/b -> $make_rat / roughnum") end
fun compile-string(s :: String) -> List<Number>: raise("TODO(port): $Str = array.new_fixed i8 of code units") end

# ===== name resolution / closures (mirror resolveName/makeClosure/freeVars) =====
fun resolve-name(name :: String, c :: Ctx) -> List<Number>:
  # order: locals (unbox if boxed) -> params (array.get caps) -> captures -> globals
  # -> data-variant constructor (reify) / is-<v> predicate / nullary variant value
  raise("TODO(port): resolve-name " + name)
end
fun make-closure(fn-index :: Number, capture-names :: List<String>, enclosing :: Ctx) -> List<Number>:
  raise("TODO(port): struct.new $Closure {fnIndex, caps-array}")
end
fun free-vars(node :: CstNode, bound :: List<String>) -> List<String>:
  # mirror compile.ts freeVars incl: lambda/fun, block (let/var/rec via nonShadow names),
  # cases-branch binds, for-expr loop vars; nonShadow so `shadow x = <expr using x>` captures outer x.
  raise("TODO(port): free-vars")
end

# ===== small shared helpers =====
fun simple-name(node :: CstNode) -> Option<String>:
  fun loop(cur :: CstNode):
    if cur.name == "id-expr": some(only(cur).value.or-else("_"))
    else if (cur.kids.length() == 1) and
        ((cur.name == "binop-expr") or (cur.name == "expr") or (cur.name == "prim-expr")): loop(cur.kids.first)
    else: none end
  end
  loop(node)
end
fun app-arg-nodes(node :: CstNode) -> List<CstNode>:
  cases(Option) child-named(node, "app-args"):
    | none => empty
    | some(a) => cases(Option) child-named(a, "opt-comma-binops"):
        | none => empty
        | some(o) => cases(Option) child-named(o, "comma-binops"):
            | none => empty | some(cb) => filter(lam(k): k.name == "binop-expr" end, cb.kids) end end
  end
end
fun idx-raise-template() -> Number: 0 end   # TODO(port): index of the template-raise helper

# ===== top level: 3 passes (mirror compileProgram) =====
# Pass 1: register top-level data + names as globals (forward refs).
# Pass 2: compile each top-level fun body (no captures).
# Pass 3: build $main — init fun globals, run statements, print last value, check-summary.
# Plus exports: main, run_pending_thunk, resume; function table; imports.
fun compile-program(program :: CstNode) -> List<Number>:
  # TODO(port): the whole driver — emit runtime (runtime.arr), prelude, user code,
  # assemble sections via encoder.module. This is the integration point.
  raise("TODO(port): compile-program")
end
