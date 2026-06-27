provide *
# wasm-of-pyret: the ANF -> WebAssembly backend for the self-hosted compiler. It
# REPLACES js-of-pyret.arr — instead of emitting JS, it walks Pyret's A-Normal-Form IR
# (ast-anf.arr) and emits a WASM-GC module via encoder.arr, on top of the value model /
# runtime emitted by runtime.arr. Mirrors the STRUCTURE of anf-loop-compiler.arr /
# js-of-pyret.arr (the real backend) so later diffing is easy.
#
# STATUS: faithful structural SKETCH of the core ANF forms. It does NOT run end-to-end
# yet (the runtime/section layout in runtime.arr + the encoder's module assembler must be
# tied in, and several forms are `# TODO(port)` stubs). It parses; compile/unbound errors
# against the still-evolving encoder/runtime are expected.

import encoder as E
import ast-anf as N
import ast as A

# ===== compile context =====
# locals: List<{key; idx}> mapping an A.Name key -> wasm local index.
# next-local: next free local slot. fenv: List<{key; tableidx}> for function-table calls.
data Ctx: ctx(locals, next-local :: Number, fenv) end
fun name-key(n): tostring(n) end          # TODO(port): use A.Name's .key()
fun bind-local(c :: Ctx, key, idx :: Number) -> Ctx:
  ctx(link({k: key, i: idx}, c.locals), num-max(c.next-local, idx + 1), c.fenv)
end
fun lookup-local(c :: Ctx, key):
  cases(List) c.locals:
    | empty => raise("wasm-of-pyret: unbound local " + key)
    | link(f, r) => if f.k == key: f.i else: lookup-local(ctx(r, c.next-local, c.fenv), key) end
  end
end
fun lookup-fn(c :: Ctx, key):
  cases(List) c.fenv:
    | empty => raise("wasm-of-pyret: unbound fn " + key)
    | link(f, r) => if f.k == key: f.i else: lookup-fn(ctx(c.locals, c.next-local, r), key) end
  end
end

# runtime-function indices (laid out by runtime.arr's build-runtime). TODO(port): import
# the real index map from runtime.arr instead of these placeholders.
fun idx-make-fix(): 0 end
fun idx-make-str(): 1 end
fun idx-make-object(): 2 end
fun idx-obj-get(): 3 end
fun idx-obj-extend(): 4 end
fun idx-make-variant(): 5 end
fun idx-variant-field(): 6 end
fun idx-variant-field-by-name(): 7 end
fun idx-variant-id(): 8 end
fun idx-truthy(): 9 end
fun idx-raise(): 10 end
T-METHOD = 0     # TODO(port): GC type indices from types.ts ordering (via runtime.arr)
T-CLOSURE = 0
ANYREF-BT = [list: 110]   # blocktype: anyref result

# ===== AVal -> instructions (leaves one anyref on the stack) =====
fun compile-aval(v, c :: Ctx) -> List<Number>:
  cases(N.AVal) v:
    | a-num(l, n) =>
      # exact small ints -> $make_fix(i64). TODO(port): rationals/roughnums/bignum.
      E.i64-const(n).append(E.call(idx-make-fix()))
    | a-str(l, s) =>
      # TODO(port): emit a $Str (array i8) from s's code points, then nothing else.
      E.call(idx-make-str())
    | a-bool(l, b) => E.ref-i31.append(E.i32-const(if b: 1 else: 0 end))
    | a-id(l, id) => E.local-get(lookup-local(c, name-key(id)))
    | a-srcloc(l, loc) => E.ref-null(110)                                   # TODO(port): srcloc value
    | a-undefined(l) => E.ref-null(110)
    | a-prim-val(l, name) => E.ref-null(110)                                # TODO(port): primitive globals
  end
end

fun compile-avals(vs, c :: Ctx) -> List<Number>:
  E.concat(vs.map(lam(v): compile-aval(v, c) end))
end

# ===== ALettable -> instructions (leaves the value; `tail` => use return_call) =====
fun compile-lettable(lt, c :: Ctx, tail :: Boolean) -> List<Number>:
  cases(N.ALettable) lt:
    | a-val(l, v) => compile-aval(v, c)
    | a-id-var(l, id) => E.local-get(lookup-local(c, name-key(id)))         # TODO(port): unbox the var cell
    | a-id-letrec(l, id, safe) => E.local-get(lookup-local(c, name-key(id)))
    | a-id-var-modref(l, id, uri, name) => E.ref-null(110)                  # TODO(port): module ref
    | a-app(l, f, args, info) =>
      # push closure, push args, (return_)call_indirect via the function table.
      callee = compile-aval(f, c)
      argc = compile-avals(args, c)
      tbl = 0
      # TODO(port): pack args into $Fields + the closure-calling-convention type index.
      tyidx = 0
      callee.append(argc).append(
        if tail: E.return-call-indirect(tyidx, tbl) else: E.call-indirect(tyidx, tbl) end)
    | a-prim-app(l, fname, args, info) =>
      # built-in primitive: map fname -> a runtime fn / intrinsic. TODO(port): full table.
      compile-avals(args, c).append(E.call(prim-index(fname)))
    | a-if(l, cnd, t, e) =>
      compile-aval(cnd, c)
        .append(E.call(idx-truthy()))
        .append(E.if-instr(ANYREF-BT))
        .append(compile-aexpr(t, c, tail))
        .append(E.else-instr)
        .append(compile-aexpr(e, c, tail))
        .append(E.end-instr)
    | a-lam(l, name, args, ret, body) =>
      # TODO(port): register a function-table entry whose body is compile-aexpr(body,...)
      # with args bound to the $Fields param, then emit struct.new $Closure {fnidx, caps}.
      E.struct-new(T-CLOSURE)
    | a-method(l, name, args, ret, body) => E.struct-new(T-METHOD)          # TODO(port)
    | a-obj(l, fields) =>
      # TODO(port): build $Names + $Fields arrays from `fields`, then $make_object.
      E.call(idx-make-object())
    | a-extend(l, supe, fields) =>
      compile-aval(supe, c).append(E.call(idx-obj-extend()))               # TODO(port): names/values
    | a-update(l, supe, fields) => compile-aval(supe, c)                    # TODO(port): mutable update
    | a-dot(l, obj, field) =>
      compile-aval(obj, c).append(E.call(idx-obj-get()))                   # TODO(port): pass field name
    | a-colon(l, obj, field) => compile-aval(obj, c)                        # TODO(port)
    | a-get-bang(l, obj, field) =>
      compile-aval(obj, c).append(E.call(idx-variant-field-by-name()))     # TODO(port): unbox the ref cell
    | a-tuple(l, fields) =>
      # tuple = variant id 0 with the fields. TODO(port): $make_variant(0, names, fields).
      compile-avals(fields, c).append(E.call(idx-make-variant()))
    | a-tuple-get(l, tup, index) =>
      compile-aval(tup, c).append(E.i32-const(index)).append(E.call(idx-variant-field()))
    | a-cases(l, typ, val, branches, els) =>
      # vtag dispatch: variant-id(val) then a nested if-chain per branch.
      # TODO(port): bind each branch's args from the variant's fields; emit the else.
      compile-aval(val, c).append(E.call(idx-variant-id())).append(E.drop-instr)
        .append(compile-aexpr(els, c, tail))
    | a-assign(l, id, value) =>
      # TODO(port): write the var's boxed cell; assignment returns nothing.
      compile-aval(value, c).append(E.local-set(lookup-local(c, name-key(id))))
        .append(E.ref-i31).append(E.i32-const(2))
    | a-method-app(l, obj, meth, args) => compile-aval(obj, c)              # TODO(port): method dispatch
    | a-data-expr(l, name, namet, variants, shared) => E.ref-i31.append(E.i32-const(2))  # TODO(port): register data at runtime
    | a-ref(l, ann) => E.ref-null(110)                                     # TODO(port): bare ref
    | a-module(l, _, _, _, _, _, _) => E.ref-null(110)                     # TODO(port): module value
  end
end

# prim-app function name -> runtime index. TODO(port): exhaustive table (mirror
# js-of-pyret's prim dispatch + the seed's compileApp intrinsic ladder).
fun prim-index(fname :: String) -> Number:
  if fname == "raise": idx-raise() else: idx-raise() end   # TODO(port)
end

# ===== AExpr -> instructions =====
fun compile-aexpr(e, c :: Ctx, tail :: Boolean) -> List<Number>:
  cases(N.AExpr) e:
    | a-let(l, b, lt, body) =>
      idx = c.next-local
      compile-lettable(lt, c, false)
        .append(E.local-set(idx))
        .append(compile-aexpr(body, bind-local(c, name-key(b.id), idx), tail))
    | a-var(l, b, lt, body) =>
      # TODO(port): box the value into a 1-cell so closures share mutation.
      idx = c.next-local
      compile-lettable(lt, c, false)
        .append(E.local-set(idx))
        .append(compile-aexpr(body, bind-local(c, name-key(b.id), idx), tail))
    | a-seq(l, e1, e2) =>
      compile-lettable(e1, c, false).append(E.drop-instr).append(compile-aexpr(e2, c, tail))
    | a-lettable(l, lt) => compile-lettable(lt, c, tail)
    | a-type-let(l, bind, body) => compile-aexpr(body, c, tail)            # types erased
    | a-arr-let(l, b, idx, lt, body) =>
      slot = c.next-local
      compile-lettable(lt, c, false)
        .append(E.local-set(slot))
        .append(compile-aexpr(body, bind-local(c, name-key(b.id), slot), tail))
  end
end

# ===== program assembler =====
fun compile-prog(prog) -> List<Number>:
  cases(N.AProg) prog:
    | a-program(l, provides, imports, body) =>
      # body compiled as the exported `main` (() -> anyref). TODO(port): assemble the
      # type/import/func/table/global/export/element/code sections, INCLUDING the runtime
      # functions from runtime.arr (build-runtime) + the user functions collected from
      # a-lam, wired through the encoder's module assembler (E.wasm-module-of / module-builder).
      body-code = compile-aexpr(body, ctx(empty, 0, empty), true)
      body-code   # TODO(port): wrap in code-entry + sections + module header
  end
end
