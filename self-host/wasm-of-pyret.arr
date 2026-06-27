provide *
# wasm-of-pyret: the ANF -> WebAssembly backend for the self-hosted compiler. It
# REPLACES js-of-pyret.arr — instead of emitting JS, it walks Pyret's A-Normal-Form IR
# (ast-anf.arr) and emits a WASM-GC module via encoder.arr, on top of the value model /
# runtime emitted by runtime.arr. Mirrors the STRUCTURE of anf-loop-compiler.arr /
# js-of-pyret.arr (the real backend) so later diffing is easy.
#
# STATUS: faithful structural SKETCH. The value-model leaf forms (num/bool/str/tuple/
# obj/dot/var-cell/assign) emit real encoder bytes against the runtime's GC type indices
# (T-* from runtime.arr/types.ts). The deeper forms (closure-calling convention with a
# temp local, a-lam function-table collection, a-cases vtag dispatch + field binds,
# a-data-expr runtime registration, and the compile-prog section ASSEMBLER tie-in to
# runtime.arr's build-runtime) are `# TODO(port)` — they need the lambda-collection pass
# and the runtime index map. It parses; it does NOT run end-to-end yet.

import encoder as E
import ast-anf as N
import ast as A

# ===== GC type indices (must match types.ts / runtime.arr's rec-group order) =====
T-NUM = 1
T-FIX = 2
T-STR = 6
T-FIELDS = 7        # (array (mut anyref)) — also the boxed-var 1-cell
T-VARIANT = 8       # (struct i32 id, (ref $Str) name, (ref $Fields) fields)
T-CLOSURE = 9       # (struct i32 fnIndex, (ref null $Fields) caps)
T-NAMES = 10        # (array (ref $Str))
T-OBJECT = 11       # (struct (ref $Names), (ref $Fields))
T-METHOD = 12       # (struct (ref $Closure))
ANYREF-BT = [list: 110]   # blocktype: single anyref result

# ===== runtime-function indices (laid out by runtime.arr's build-runtime) =====
# TODO(port): import the real name->index map from runtime.arr's assembler instead of
# these placeholders; the function index space is [imports ++ runtime fns ++ user lambdas].
fun idx-make-object(): 2 end
fun idx-obj-get(): 3 end
fun idx-obj-extend(): 4 end
fun idx-variant-field-by-name(): 7 end
fun idx-variant-id(): 8 end
fun idx-truthy(): 9 end
fun idx-raise(): 10 end

# ===== compile context =====
# locals: List<{k; i}> A.Name-key -> wasm local index. vars: keys that are BOXED (a-var)
# so a-id-var/a-assign go through the 1-cell. fenv: List<{k; i}> fn-name -> table index.
data Ctx: ctx(locals, next-local :: Number, vars, fenv) end
fun name-key(n): tostring(n) end          # TODO(port): use A.Name's .key()
fun bind-local(c :: Ctx, key, idx :: Number) -> Ctx:
  ctx(link({k: key, i: idx}, c.locals), num-max(c.next-local, idx + 1), c.vars, c.fenv)
end
fun bind-var(c :: Ctx, key, idx :: Number) -> Ctx:
  ctx(link({k: key, i: idx}, c.locals), num-max(c.next-local, idx + 1), link(key, c.vars), c.fenv)
end
fun is-var(c :: Ctx, key) -> Boolean: c.vars.member(key) end
fun lookup-local(c :: Ctx, key):
  cases(List) c.locals:
    | empty => raise("wasm-of-pyret: unbound local " + key)
    | link(f, r) => if f.k == key: f.i else: lookup-local(ctx(r, c.next-local, c.vars, c.fenv), key) end
  end
end

# ===== a $Str (array i8) from a Pyret string's code points =====
fun emit-str(s :: String) -> List<Number>:
  cps = string-to-code-points(s)
  E.concat(cps.map(lam(cp): E.i32-const(cp) end)).append(E.array-new-fixed(T-STR, length(cps)))
end
# read the boxed-var 1-cell at local `idx` -> its value
fun box-read(idx :: Number) -> List<Number>:
  E.local-get(idx).append(E.i32-const(0)).append(E.array-get(T-FIELDS))
end

# ===== AVal -> instructions (leaves one anyref on the stack) =====
fun compile-aval(v, c :: Ctx) -> List<Number>:
  cases(N.AVal) v:
    | a-num(l, n) =>
      # exact small ints -> $make_fix(i64). TODO(port): rationals/roughnums/bignum literals.
      E.i64-const(n).append(E.i-call(0))   # 0 = $make_fix placeholder
    | a-str(l, s) => emit-str(s)
    | a-bool(l, b) => E.i32-const(if b: 1 else: 0 end).append(E.ref-i31)
    | a-id(l, id) =>
      k = name-key(id)
      if is-var(c, k): box-read(lookup-local(c, k)) else: E.local-get(lookup-local(c, k)) end
    | a-srcloc(l, loc) => E.i-ref-null(110)                                # TODO(port): srcloc value
    | a-undefined(l) => E.i-ref-null(110)
    | a-prim-val(l, name) => E.i-ref-null(110)                             # TODO(port): primitive globals
  end
end

fun compile-avals(vs, c :: Ctx) -> List<Number>:
  E.concat(vs.map(lam(v): compile-aval(v, c) end))
end
# pack a list of already-on-stack values into a $Fields array (caller pushed them)
fun pack-fields(vs, c :: Ctx) -> List<Number>:
  compile-avals(vs, c).append(E.array-new-fixed(T-FIELDS, length(vs)))
end
# a $Names array of $Str from field names
fun emit-names(flds) -> List<Number>:
  E.concat(flds.map(lam(f): emit-str(f.name) end)).append(E.array-new-fixed(T-NAMES, length(flds)))
end

# ===== ALettable -> instructions (leaves the value; `tail` => return_call) =====
fun compile-lettable(lt, c :: Ctx, tail :: Boolean) -> List<Number>:
  cases(N.ALettable) lt:
    | a-val(l, v) => compile-aval(v, c)
    | a-id-var(l, id) =>
      k = name-key(id)
      if is-var(c, k): box-read(lookup-local(c, k)) else: E.local-get(lookup-local(c, k)) end
    | a-id-letrec(l, id, safe) => E.local-get(lookup-local(c, name-key(id)))
    | a-id-var-modref(l, id, uri, name) => E.i-ref-null(110)               # TODO(port): module ref
    | a-app(l, f, args, info) =>
      # closure-calling convention: (ClosureRef, FieldsRefNull)->anyref via the table.
      # push closure, push args-as-$Fields, push fnIndex(=struct.get closure 0), call_indirect.
      # TODO(port): stash the closure in a temp local (it's used twice) + the real type index.
      tyidx = 0
      compile-aval(f, c)
        .append(pack-fields(args, c))
        .append(if tail: E.i-return-call-indirect(tyidx, 0) else: E.i-call-indirect(tyidx, 0) end)
    | a-prim-app(l, fname, args, info) =>
      compile-avals(args, c).append(E.i-call(prim-index(fname)))
    | a-if(l, cnd, t, e) =>
      compile-aval(cnd, c)
        .append(E.i-call(idx-truthy()))
        .append(E.i-if(ANYREF-BT))
        .append(compile-aexpr(t, c, tail))
        .append(E.i-else)
        .append(compile-aexpr(e, c, tail))
        .append(E.i-end)
    | a-lam(l, name, args, ret, body) =>
      # closure value: struct.new $Closure {fnIndex, caps}. TODO(port): the function-table
      # entry (its body = compile-aexpr(body) with args bound to the $Fields param) must be
      # COLLECTED by the assembler so fnIndex is real; caps = the captured free vars.
      E.i32-const(0).append(E.i-ref-null(T-FIELDS)).append(E.struct-new(T-CLOSURE))
    | a-method(l, name, args, ret, body) =>
      E.i32-const(0).append(E.i-ref-null(T-FIELDS)).append(E.struct-new(T-CLOSURE)).append(E.struct-new(T-METHOD))
    | a-obj(l, fields) =>
      # $make_object(names, values)
      emit-names(fields)
        .append(pack-fields(fields.map(lam(f): f.value end), c))
        .append(E.i-call(idx-make-object()))
    | a-extend(l, supe, fields) =>
      compile-aval(supe, c)
        .append(emit-names(fields))
        .append(pack-fields(fields.map(lam(f): f.value end), c))
        .append(E.i-call(idx-obj-extend()))
    | a-update(l, supe, fields) => compile-aval(supe, c)                    # TODO(port): mutable update
    | a-dot(l, obj, field) =>
      compile-aval(obj, c).append(emit-str(field)).append(E.i-call(idx-obj-get()))
    | a-colon(l, obj, field) => compile-aval(obj, c)                        # TODO(port): method/field colon
    | a-get-bang(l, obj, field) =>
      # read the ref-cell field by name, then unbox the cell. TODO(port): unbox.
      compile-aval(obj, c).append(emit-str(field)).append(E.i-call(idx-variant-field-by-name()))
    | a-tuple(l, fields) =>
      # tuple = $Variant id 0, name "tuple", fields.
      E.i32-const(0).append(emit-str("tuple")).append(pack-fields(fields, c)).append(E.struct-new(T-VARIANT))
    | a-tuple-get(l, tup, index) =>
      compile-aval(tup, c)
        .append(E.ref-cast(T-VARIANT))
        .append(E.struct-get(T-VARIANT, 2))   # the $Fields
        .append(E.i32-const(index)).append(E.array-get(T-FIELDS))
    | a-cases(l, typ, val, branches, els) =>
      # vtag dispatch: compute variant-id(val), then a nested if-chain per branch comparing
      # the id; bind each branch's args from the variant's fields; final else.
      # TODO(port): map each branch name -> its variant id (needs the data registry) and
      # bind args via array.get on the variant's $Fields. For now: variant-id then else.
      compile-aval(val, c).append(E.i-call(idx-variant-id())).append(E.i-drop)
        .append(compile-aexpr(els, c, tail))
    | a-assign(l, id, value) =>
      # write the var's 1-cell: cell[0] := value ; assignment returns nothing.
      k = name-key(id)
      E.local-get(lookup-local(c, k))
        .append(E.i32-const(0))
        .append(compile-aval(value, c))
        .append(E.array-set(T-FIELDS))
        .append(E.i32-const(2)).append(E.ref-i31)
    | a-method-app(l, obj, meth, args) => compile-aval(obj, c)              # TODO(port): method dispatch
    | a-data-expr(l, name, namet, variants, shared) =>
      E.i32-const(2).append(E.ref-i31)                                     # TODO(port): runtime data registration
    | a-ref(l, ann) => E.i-ref-null(110)                                   # TODO(port): bare ref
    | a-module(l, ans, dv, dt, prov, types, checks) => E.i-ref-null(110)   # TODO(port): module value
  end
end

# prim-app function name -> runtime index. TODO(port): exhaustive table (mirror
# js-of-pyret's prim dispatch + the seed's compileApp intrinsic ladder).
fun prim-index(fname :: String) -> Number:
  idx-raise()   # TODO(port)
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
      # box the value into a 1-cell $Fields so closures share the mutation.
      idx = c.next-local
      compile-lettable(lt, c, false)
        .append(E.array-new-fixed(T-FIELDS, 1))
        .append(E.local-set(idx))
        .append(compile-aexpr(body, bind-var(c, name-key(b.id), idx), tail))
    | a-seq(l, e1, e2) =>
      compile-lettable(e1, c, false).append(E.i-drop).append(compile-aexpr(e2, c, tail))
    | a-lettable(l, lt) => compile-lettable(lt, c, tail)
    | a-type-let(l, bind, body) => compile-aexpr(body, c, tail)            # types erased
    | a-arr-let(l, b, idx2, lt, body) =>
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
      # The program body is the exported `main : () -> anyref`.
      body-code = compile-aexpr(body, ctx(empty, 0, empty, empty), true)
      main-code = E.code-entry([list: ], body-code)
      # TODO(port): assemble the full module. The pieces, via E.wasm-module-of(type, import,
      # func, table, mem, global, export, elem, code):
      #   - type section: the GC rec-group ($Num..$Method) + the closure call func-type,
      #     emitted by runtime.arr (it owns the type layout).
      #   - runtime functions: runtime.arr's build-runtime() -> their code entries, FIRST in
      #     the func/code space, so the idx-* above resolve.
      #   - user lambdas: collected from a-lam during compilation (a mutable registry the
      #     assembler threads), each a code entry whose body is its compiled AExpr.
      #   - func section: type indices for runtime fns ++ lambdas ++ main.
      #   - table + element segment: all closure-callable fn indices (for call_indirect).
      #   - export: "main" -> the main func index.
      #   - code section: runtime code ++ lambda code ++ main-code.
      # For now return just main's code entry (a valid code-entry, not yet a whole module).
      main-code
  end
end
