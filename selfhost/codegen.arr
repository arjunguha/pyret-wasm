provide *
# Codegen for the self-hosted Pyret->WASM compiler: AST -> WASM module bytes.
# Uses encoder.arr (leb/section/functype/...) and ast.arr (Expr/Def/Prog).
# env = local names (params + lets); fenv = function names (for call indices).

fun compile-expr(e, env, fenv):
  cases(Expr) e:
    | num(v) => append([list: 65], sleb(v))
    | vref(nm) => append([list: 32], leb-u(index-of(env, nm)))
    | app(fn, args) =>
      argbytes = concat(map(lam(a): compile-expr(a, env, fenv) end, args))
      append(argbytes, append([list: 16], leb-u(index-of(fenv, fn))))   # call N
    | add(l, r) => concat([list: compile-expr(l, env, fenv), compile-expr(r, env, fenv), [list: 106]])
    | sub(l, r) => concat([list: compile-expr(l, env, fenv), compile-expr(r, env, fenv), [list: 107]])
    | mul(l, r) => concat([list: compile-expr(l, env, fenv), compile-expr(r, env, fenv), [list: 108]])
    | lt(l, r) => concat([list: compile-expr(l, env, fenv), compile-expr(r, env, fenv), [list: 72]])
    | gt(l, r) => concat([list: compile-expr(l, env, fenv), compile-expr(r, env, fenv), [list: 74]])
    | iff(c, t, el) =>
      concat([list: compile-expr(c, env, fenv), [list: 4, 127],
                    compile-expr(t, env, fenv), [list: 5],
                    compile-expr(el, env, fenv), [list: 11]])
    | letx(nm, v, body) =>
      idx = length(env)
      concat([list: compile-expr(v, env, fenv), [list: 33], leb-u(idx),
                    compile-expr(body, append(env, [list: nm]), fenv)])
  end
end

fun fn-code(params, body, fenv):
  b = append(compile-expr(body, params, fenv), [list: 11])
  k = let-depth(body)
  locals-decl = if k == 0: [list: 0] else: append(leb-u(1), append(leb-u(k), [list: 127])) end
  byte-vec(append(locals-decl, b))
end

fun compile-prog(p):
  cases(Prog) p:
    | prog(defs, mainx) =>
      fnames = map(def-name, defs)
      ndefs = length(defs)
      def-types = map(lam(d): functype(map(lam(x): 127 end, def-params(d)), [list: 127]) end, defs)
      types = append(def-types, [list: functype(empty, [list: 127])])  # + main : -> i32
      n = length(types)
      type-sec = section(1, vec(types))
      func-sec = section(3, vec(map(lam(i): leb-u(i) end, range(0, n))))
      def-codes = map(lam(d): fn-code(def-params(d), def-body(d), fnames) end, defs)
      codes = append(def-codes, [list: fn-code(empty, mainx, fnames)])
      code-sec = section(10, vec(codes))
      export-sec = section(7, vec([list: append(byte-vec([list: 109, 97, 105, 110]), [list: 0, ndefs])]))
      concat([list: [list: 0, 97, 115, 109, 1, 0, 0, 0], type-sec, func-sec, export-sec, code-sec])
  end
end
