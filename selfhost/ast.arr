provide *
# AST + token data definitions for the self-hosted Pyret->WASM compiler.

data Expr:
  | num(value)
  | vref(name)
  | app(fname, args)
  | add(left, right)
  | sub(left, right)
  | mul(left, right)
  | lt(left, right)
  | gt(left, right)
  | iff(c, t, e)
  | letx(name, value, body)
end
data Def: | fundef(name, params, body) end
data Prog: | prog(defs, mainx) end

data Tok:
  | tnum(value) | tid(name)
  | tplus | tminus | ttimes
  | tlparen | trparen
  | tlt | tgt
  | tif | tthen | telse | tend
  | tlet | tin | teq
  | tfun | tcolon | tcomma
end

fun def-name(d): cases(Def) d: | fundef(nm, ps, body) => nm end end
fun def-params(d): cases(Def) d: | fundef(nm, ps, body) => ps end end
fun def-body(d): cases(Def) d: | fundef(nm, ps, body) => body end end

# Max let-nesting depth of an expression -> number of i32 locals the function needs.
fun let-depth(e):
  cases(Expr) e:
    | num(v) => 0
    | vref(nm) => 0
    | app(fn, args) => foldl(lam(acc, a): num-max(acc, let-depth(a)) end, 0, args)
    | add(l, r) => num-max(let-depth(l), let-depth(r))
    | sub(l, r) => num-max(let-depth(l), let-depth(r))
    | mul(l, r) => num-max(let-depth(l), let-depth(r))
    | lt(l, r) => num-max(let-depth(l), let-depth(r))
    | gt(l, r) => num-max(let-depth(l), let-depth(r))
    | iff(c, t, el) => num-max(let-depth(c), num-max(let-depth(t), let-depth(el)))
    | letx(nm, v, body) => num-max(let-depth(v), 1 + let-depth(body))
  end
end
