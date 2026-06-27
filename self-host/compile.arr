#lang pyret
# PORT of src/compiler/compile.ts — the Pyret->WASM codegen, written in Pyret.
# Consumes the CST (name/kids/value tree from the reused parser) and emits a WASM
# module via encoder.arr (the binaryen replacement). The seed compiles THIS into
# compiler.wasm; the fixpoint is compiler.wasm compiling its own source identically.
#
# ===== PORT NOTES =====
# binaryen builds an expression TREE; the encoder builds a stack-machine BYTE STREAM.
# So every `m.call("$f", [a, b])` becomes  <bytes a> ++ <bytes b> ++ E.call(rt("$f")):
# operands are emitted first, then the op. compile-expr returns List<Number> = the
# bytes that leave the expr's value on the operand stack. `tail` enables
# return_call_indirect for proper tail calls.
#
# Faithfully ported: literals (int/rational/string/bool), binops (+ ^ and/or cmp ==),
#   if / else-if chain, closure calling convention, resolve-name lookup order, var
#   boxing (unbox/make-box/set-box), lambda + make-closure, block/emit-stmt, a
#   representative slice of the intrinsic ladder, free-vars (id/lambda).
# TODO(port): exhaustive intrinsic ladder; cases vtag dispatch; data/object/extend/
#   for/tuples/assign; bignum literals; exact cmp i32 tests; f64 IEEE bits; the
#   compile-program driver (runtime+prelude+user assembly). Runtime function indices
#   (rt) and GC type indices (t-*) are placeholders until the assembler lays them out
#   to match runtime.arr / types.ts.

provide *
import encoder as E
# TODO(port): import the shared CstNode type + prelude.arr source.
data CstNode: cst(name :: String, value :: Option<String>, kids :: List<CstNode>) end

# ---- raw byte helpers (ops the encoder may not expose yet) ----
END = [list: 11]            # 0x0B end
ELSE-B = [list: 5]          # 0x05 else
DROP = [list: 26]           # 0x1A drop
ANYREF-BT = [list: 110]     # if/block result type: value type anyref (0x6E)
fun i31-get-s() -> List<Number>: [list: 251, 29] end   # 0xFB 0x1D
fun ref-i31() -> List<Number>: [list: 251, 28] end     # 0xFB 0x1C
I32-EQZ = [list: 69]
I32-AND = [list: 113]
I32-OR = [list: 114]
I31REF-HT = 108

# ---- value-model GC type indices (must match runtime.arr rec groups / types.ts) ----
# placeholders; the assembler fixes the real layout (mirrors types.ts buildTypes order).
fun t-num() -> Number: 0 end
fun t-fixnum() -> Number: 1 end
fun t-roughnum() -> Number: 3 end
fun t-str() -> Number: 6 end
fun t-fields() -> Number: 7 end
fun t-variant() -> Number: 8 end
fun t-closure() -> Number: 9 end
fun closure-sig() -> Number: 0 end   # function-type index for (closure, fields) -> anyref

# runtime function index by name (placeholder; assembler maps name -> index per runtime.arr)
runtime-names :: List<String> = [list:
  "$make_fix", "$make_rough", "$make_rat", "$plus", "$equal", "$num_compare",
  "$num_add", "$num_sub", "$num_mul", "$num_divide", "$tostring",
  "$raise", "$print", "$num_to_string", "$no_branch" ]
fun rt(name :: String) -> Number:
  fun loop(l, i): cases(List) l: | empty => 0 | link(f, r) => if f == name: i else: loop(r, i + 1) end end end
  loop(runtime-names, 0)   # TODO(port): offset by the import count in the assembled module
end
fun arith-fn(op :: String) -> Option<String>:
  ask:
    | op == "PLUS" then: some("$num_add")    | op == "MINUS" then: some("$num_sub")
    | op == "TIMES" then: some("$num_mul")   | op == "DIVIDE" then: some("$num_divide")
    | otherwise: none
  end
end
fun cmp-pred(op :: String) -> Option<String>:
  ask: | op == "LT" then: some("lt") | op == "LEQ" then: some("leq") | op == "GT" then: some("gt")
       | op == "GEQ" then: some("geq") | otherwise: none end
end

# ---- compilation context (replaces compile.ts's Ctx class + `this`) ----
data Ctx: ctx(top :: Boolean, locals :: List<String>, params :: List<String>,
              captures :: List<String>, boxed :: List<String>) end
fun fresh-ctx(top :: Boolean) -> Ctx: ctx(top, empty, empty, empty, empty) end
fun idx-of(l :: List<String>, x :: String) -> Number:
  fun loop(cur, i): cases(List) cur: | empty => 0 - 1 | link(f, r) => if f == x: i else: loop(r, i + 1) end end end
  loop(l, 0)
end

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
fun header-param-bindings(fn-like :: CstNode) -> List<CstNode>:
  cases(Option) child-named(fn-like, "fun-header"):
    | none => empty
    | some(h) => cases(Option) child-named(h, "args"):
        | none => empty | some(a) => filter(lam(k): k.name == "binding" end, a.kids) end
  end
end
fun header-params(fn-like :: CstNode) -> List<String>:
  map(binding-name, header-param-bindings(fn-like))
end

# ===== expressions: the central dispatch (mirror compileExpr's switch) =====
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
    | node.name == "bool-expr" then: E.i32-const(if only(node).name == "TRUE": 1 else: 0 end).append(ref-i31())
    | node.name == "string-expr" then: compile-string(only(node).value.or-else(""))
    | node.name == "if-expr" then: compile-if(node, c, tail)
    | node.name == "construct-expr" then: compile-construct(node, c)
    | node.name == "obj-expr" then: compile-object(node, c)
    | node.name == "dot-expr" then: compile-dot(node, c)
    | node.name == "for-expr" then: compile-for(node, c, tail)
    | node.name == "user-block-expr" then: compile-block(child-named(node, "block").value, c, tail)
    | node.name == "inst-expr" then: compile-expr(node.kids.first, c, tail)
    | node.name == "tuple-expr" then: compile-tuple(node, c)
    | node.name == "tuple-get" then: compile-tuple-get(node, c)
    | node.name == "assign-expr" then: compile-assign(node, c)
    | node.name == "extend-expr" then: compile-extend(node, c)
    | node.name == "template-expr" then: E.call(rt("$raise"))
    | otherwise: raise("unsupported expression: " + node.name)
  end
end

# ===== literals (mirror compileNumber/intLiteral/compileString/compileRational) =====
fun compile-number(text :: String) -> List<Number>:
  s = if string-char-at(text, 0) == "~": string-substring(text, 1, string-length(text)) else: text end
  rough = not(text == s) or has-decimal(s)
  if rough:
    E.f64-const-bits(f64-bits(string-to-num-or(s, 0))).append(E.call(rt("$make_rough")))
  else:
    int-literal(string-to-num-or(s, 0))
  end
end
fun int-literal(v :: Number) -> List<Number>:
  # Fixnum path: i64.const v ; call $make_fix. TODO(port): bignum when |v| >= 2^63.
  E.i64-const(v).append(E.call(rt("$make_fix")))
end
fun compile-rational(text :: String, rough :: Boolean) -> List<Number>:
  s = if string-char-at(text, 0) == "~": string-substring(text, 1, string-length(text)) else: text end
  parts = string-split(s, "/")
  n = string-to-num-or(parts.first, 0)
  d = string-to-num-or(parts.rest.first, 1)
  if rough:
    E.f64-const-bits(f64-bits(n / d)).append(E.call(rt("$make_rough")))
  else:
    int-literal(n).append(int-literal(d)).append(E.call(rt("$make_rat")))
  end
end
fun compile-string(text :: String) -> List<Number>:
  cps = string-to-code-points(strip-quotes(text))
  concat-bytes(map(lam(cp): E.i32-const(cp) end, cps)).append(E.array-new-fixed(t-str(), cps.length()))
end

# ===== binops (mirror compileBinopExpr/applyBinop), linearized =====
fun compile-binop(node :: CstNode, c :: Ctx) -> List<Number>:
  kids = node.kids
  fun loop(acc :: List<Number>, i :: Number) -> List<Number>:
    if (i + 1) >= kids.length(): acc
    else:
      op-tok = only(kids.get(i))
      if op-tok.name == "CARET":
        # `a ^ f` = f(a): the accumulated value is the single arg to the closure f.
        fn-bytes = compile-expr(kids.get(i + 1), c, false)
        loop(call-closure-bytes(fn-bytes, [list: acc], c, false), i + 2)
      else:
        right = compile-expr(kids.get(i + 1), c, false)
        loop(apply-binop(op-tok.name, acc, right), i + 2)
      end
    end
  end
  loop(compile-expr(kids.first, c, false), 1)
end
fun apply-binop(op :: String, left :: List<Number>, right :: List<Number>) -> List<Number>:
  ask:
    | op == "PLUS" then: left.append(right).append(E.call(rt("$plus")))
    | is-some(arith-fn(op)) then:
      as-num(left).append(as-num(right)).append(E.call(rt(arith-fn(op).value)))
    | is-some(cmp-pred(op)) then:
      cmp-to-bool(cmp-pred(op).value, as-num(left).append(as-num(right)).append(E.call(rt("$num_compare"))))
    | op == "EQUALEQUAL" then: mk-bool(left.append(right).append(E.call(rt("$equal"))))
    | op == "NEQ" then: mk-bool(left.append(right).append(E.call(rt("$equal"))).append(I32-EQZ))
    | op == "AND" then: mk-bool(truthy(left).append(truthy(right)).append(I32-AND))
    | op == "OR" then: mk-bool(truthy(left).append(truthy(right)).append(I32-OR))
    | otherwise: raise("unsupported binop: " + op)
  end
end
fun as-num(bytes :: List<Number>) -> List<Number>: bytes.append(E.ref-cast(t-num())) end
fun truthy(bytes :: List<Number>) -> List<Number>: bytes.append(E.ref-cast(I31REF-HT)).append(i31-get-s()) end
fun mk-bool(i32-bytes :: List<Number>) -> List<Number>: i32-bytes.append(ref-i31()) end
fun cmp-to-bool(which :: String, cmp-bytes :: List<Number>) -> List<Number>:
  # TODO(port): emit the i32 test of the compare-result (-1/0/1) per `which` (lt/leq/gt/geq).
  mk-bool(cmp-bytes)
end

# ===== if (mirror compileIf) =====
fun compile-if(node :: CstNode, c :: Ctx, tail :: Boolean) -> List<Number>:
  kids = node.kids
  cond = child-named(node, "binop-expr").value
  blocks = filter(lam(k): k.name == "block" end, kids)
  elseifs = filter(lam(k): k.name == "else-if" end, kids)
  has-else = is-some(find(lam(k): k.name == "ELSECOLON" end, kids))
  else-expr =
    if has-else: compile-block(blocks.get(blocks.length() - 1), c, tail)
    else: E.call(rt("$no_branch")) end
  fun fold-eis(eis :: List<CstNode>, acc :: List<Number>) -> List<Number>:
    cases(List) eis:
      | empty => acc
      | link(ei, rest) =>
        ec = child-named(ei, "binop-expr").value
        eb = child-named(ei, "block").value
        nested = truthy(compile-expr(ec, c, false))
          .append(E.if-instr(ANYREF-BT)).append(compile-block(eb, c, tail))
          .append(ELSE-B).append(acc).append(END)
        fold-eis(rest, nested)
    end
  end
  chained-else = fold-eis(elseifs.reverse(), else-expr)
  then-expr = compile-block(blocks.first, c, tail)
  truthy(compile-expr(cond, c, false))
    .append(E.if-instr(ANYREF-BT)).append(then-expr).append(ELSE-B).append(chained-else).append(END)
end

# ===== application: intrinsics vs closure call (mirror compileApp) =====
intrinsics :: List<String> = [list:
  "raise", "print", "display", "tostring", "torepr", "identical",
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
      else: call-closure-value(resolve-name(name, c), arg-nodes, c, tail) end
    | none => call-closure-value(compile-expr(fn-node, c, false), arg-nodes, c, tail)
  end
end
fun compile-intrinsic(name :: String, args :: List<CstNode>, c :: Ctx, tail :: Boolean) -> List<Number>:
  ab = concat-bytes(map(lam(a): compile-expr(a, c, false) end, args))
  ask:
    | name == "raise" then: ab.append(E.call(rt("$raise")))
    | (name == "print") or (name == "display") then: ab.append(E.call(rt("$print")))
    | (name == "tostring") or (name == "torepr") then: ab.append(E.call(rt("$tostring")))
    | name == "num-to-string" then: ab.append(E.call(rt("$num_to_string")))
    | name == "raw-array-get" then: ab.append(E.array-get(t-fields()))
    | name == "raw-array-set" then: ab.append(E.array-set(t-fields()))
    | name == "raw-array-length" then: ab.append([list: 251, 15])  # array.len
    | otherwise: raise("TODO(port): intrinsic " + name)
  end
end

# closure calling convention: $Closure{fnIndex, caps}; (return_)call_indirect on $tab
# with sig (closure, fields). Args given as CstNodes (compile each) -> packed $Fields.
fun call-closure-value(closure-bytes :: List<Number>, args :: List<CstNode>, c :: Ctx, tail :: Boolean) -> List<Number>:
  call-closure-bytes(closure-bytes, map(lam(a): compile-expr(a, c, false) end, args), tail-of(c, tail))
end
fun tail-of(c :: Ctx, tail :: Boolean) -> Boolean: tail end
# variant taking already-compiled arg byte-lists (used by `^` and the CstNode path).
fun call-closure-bytes(closure-bytes :: List<Number>, arg-byte-lists :: List<List<Number>>, tail :: Boolean) -> List<Number>:
  n = arg-byte-lists.length()
  packed = if n == 0: E.ref-null(t-fields())
    else: concat-bytes(arg-byte-lists).append(E.array-new-fixed(t-fields(), n)) end
  call-instr = if tail: E.return-call-indirect(closure-sig(), 0) else: E.call-indirect(closure-sig(), 0) end
  # TODO(port): bind the closure to a local to avoid emitting closure-bytes twice
  # (compile.ts uses a closureLocal). Here we push closure, args, then fnIndex via a
  # second read of the closure -> needs the local. Sketch keeps the shape.
  closure-bytes.append(E.ref-cast(t-closure()))
    .append(packed)
    .append(E.struct-get(t-closure(), 0))   # fnIndex (TODO: from the closure local)
    .append(call-instr)
end

# ===== name resolution / closures (mirror resolveName/makeClosure/unbox) =====
fun resolve-name(name :: String, c :: Ctx) -> List<Number>:
  ask:
    | name == "nothing" then: E.i32-const(2).append(ref-i31())
    | idx-of(c.locals, name) >= 0 then:
      cell = E.local-get(idx-of(c.locals, name))
      if c.boxed.member(name): unbox(cell) else: cell end
    | idx-of(c.params, name) >= 0 then:
      E.local-get(1).append(E.i32-const(idx-of(c.params, name))).append(E.array-get(t-fields()))
    | idx-of(c.captures, name) >= 0 then:
      caps = E.local-get(0).append(E.struct-get(t-closure(), 1))
      cell = caps.append(E.i32-const(idx-of(c.captures, name))).append(E.array-get(t-fields()))
      if c.boxed.member(name): unbox(cell) else: cell end
    | otherwise:
      # TODO(port): top-level global.get; data-variant ctor/predicate reify; tostring reify.
      raise("TODO(port): resolve global/variant " + name)
  end
end
fun unbox(cell :: List<Number>) -> List<Number>:
  cell.append(E.ref-cast(t-fields())).append(E.i32-const(0)).append(E.array-get(t-fields()))
end
fun make-box(value :: List<Number>) -> List<Number>:
  value.append(E.array-new-fixed(t-fields(), 1))
end
fun set-box(cell :: List<Number>, value :: List<Number>) -> List<Number>:
  cell.append(E.ref-cast(t-fields())).append(E.i32-const(0)).append(value).append(E.array-set(t-fields()))
end
fun make-closure(fn-index :: Number, capture-names :: List<String>, enclosing :: Ctx) -> List<Number>:
  caps = if capture-names.length() == 0: E.ref-null(t-fields())
    else: concat-bytes(map(lam(nm): resolve-name(nm, enclosing) end, capture-names))
           .append(E.array-new-fixed(t-fields(), capture-names.length())) end
  E.i32-const(fn-index).append(caps).append(E.struct-new(t-closure()))
end

# ===== lambda (mirror compileLambda/buildClosureFromParts) =====
fun compile-lambda(node :: CstNode, c :: Ctx) -> List<Number>:
  params = header-params(node)
  body = child-named(node, "block").value
  free = filter(lam(nm): is-bound(nm, c) end, free-vars(body, params))
  make-closure(register-fn(params, body, free), free, c)
end
fun is-bound(name :: String, c :: Ctx) -> Boolean:
  (idx-of(c.locals, name) >= 0) or (idx-of(c.params, name) >= 0) or (idx-of(c.captures, name) >= 0)
end
fun register-fn(params :: List<String>, body :: CstNode, caps :: List<String>) -> Number:
  # TODO(port): compile the body in a fresh Ctx (params + caps), add to the function
  # table, return its index. Mirror buildClosureFromParts/compileFunctionParts.
  0
end

# ===== blocks (mirror compileBlock/emitStmt) =====
fun compile-block(block :: CstNode, c :: Ctx, tail :: Boolean) -> List<Number>:
  stmts = filter(lam(k): k.name == "stmt" end, block.kids)
  fun loop(ss :: List<CstNode>, acc :: List<Number>) -> List<Number>:
    cases(List) ss:
      | empty => if acc == empty: E.i32-const(2).append(ref-i31()) else: acc end   # nothing
      | link(s, rest) =>
        is-last = rest == empty
        loop(rest, acc.append(emit-stmt(stmt-inner(s), c, tail and is-last, is-last)))
    end
  end
  loop(stmts, empty)
end
fun stmt-inner(s :: CstNode) -> CstNode: only(s) end
fun emit-stmt(inner :: CstNode, c :: Ctx, tail :: Boolean, is-last :: Boolean) -> List<Number>:
  ask:
    | inner.name == "let-expr" then: raise("TODO(port): let -> local.set (+box if captured-mutated)")
    | inner.name == "var-expr" then: raise("TODO(port): var -> boxed local.set")
    | inner.name == "fun-expr" then: raise("TODO(port): local fun -> compileLocalFun")
    | otherwise:
      bytes = compile-expr(inner, c, tail)
      if is-last: bytes else: bytes.append(DROP) end
  end
end

# ===== still-TODO expression compilers (faithful signatures; bodies at debug time) =====
fun compile-cases(node :: CstNode, c :: Ctx, tail :: Boolean) -> List<Number>: raise("TODO(port): cases -> variant-id dispatch + field binds") end
fun compile-construct(node :: CstNode, c :: Ctx) -> List<Number>: raise("TODO(port): [ctor: ...] -> ctor.make([raw-array: ...])") end
fun compile-object(node :: CstNode, c :: Ctx) -> List<Number>: raise("TODO(port): $Object {names, values}") end
fun compile-dot(node :: CstNode, c :: Ctx) -> List<Number>: raise("TODO(port): field access by name / method") end
fun compile-extend(node :: CstNode, c :: Ctx) -> List<Number>: raise("TODO(port): obj.{f:v} -> $obj_extend") end
fun compile-for(node :: CstNode, c :: Ctx, tail :: Boolean) -> List<Number>: raise("TODO(port): for -> HOF call") end
fun compile-tuple(node :: CstNode, c :: Ctx) -> List<Number>: raise("TODO(port): tuple variant id 0") end
fun compile-tuple-get(node :: CstNode, c :: Ctx) -> List<Number>: raise("TODO(port): tuple .{n}") end
fun compile-assign(node :: CstNode, c :: Ctx) -> List<Number>: raise("TODO(port): := local/global/box set") end

# ===== free-var analysis (mirror freeVars; sketch covers id/lambda) =====
fun free-vars(node :: CstNode, bound :: List<String>) -> List<String>:
  if node.name == "id-expr":
    nm = only(node).value.or-else("_")
    if bound.member(nm): empty else: [list: nm] end
  else if (node.name == "lambda-expr") or (node.name == "fun-expr"):
    b2 = bound.append(header-params(node))
    cases(Option) child-named(node, "block"): | none => empty | some(b) => free-vars(b, b2) end
  else:
    # TODO(port): block let/var/rec (nonShadow) binds, cases-branch binds, for loop vars.
    foldl(lam(acc, k): acc.append(free-vars(k, bound)) end, empty, node.kids)
  end
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
fun concat-bytes(lol :: List<List<Number>>) -> List<Number>:
  foldl(lam(acc, b): acc.append(b) end, empty, lol)
end
fun has-decimal(s :: String) -> Boolean: string-contains(s, ".") end
fun strip-quotes(s :: String) -> String:
  if (string-length(s) >= 2) and ((string-char-at(s, 0) == "\"") or (string-char-at(s, 0) == "'")):
    string-substring(s, 1, string-length(s) - 1) else: s end
end
fun string-to-num-or(s :: String, d :: Number) -> Number:
  cases(Option) string-to-number(s): | some(n) => n | none => d end
end
fun f64-bits(x :: Number) -> List<Number>: [list: 0, 0, 0, 0, 0, 0, 0, 0] end  # TODO(port): IEEE-754 LE bits

# ===== top level: 3 passes (mirror compileProgram) =====
fun compile-program(program :: CstNode) -> List<Number>:
  # TODO(port): the integration driver — emit runtime (runtime.arr build-runtime),
  # prelude, user code; lay out type/import/func/table/global/export/code sections;
  # assemble via E.wasm-module. Here is where rt()/t-* placeholders get fixed up.
  E.wasm-module(empty)
end
