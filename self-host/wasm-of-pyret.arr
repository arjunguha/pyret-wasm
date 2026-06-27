provide *
# wasm-of-pyret: the ANF -> WebAssembly backend for the self-hosted compiler. It
# REPLACES js-of-pyret.arr — instead of emitting JS, it walks Pyret's A-Normal-Form IR
# (ast-anf.arr) and emits a WASM-GC module via encoder.arr, on top of the value model /
# runtime emitted by runtime.arr. Mirrors the STRUCTURE of anf-loop-compiler.arr /
# js-of-pyret.arr (the real backend) so later diffing is easy.
#
# STATUS: faithful structural port. The value-model leaf forms (num/bool/str/tuple/obj/
# dot/var-cell/assign) emit real encoder bytes against the runtime's GC type indices.
# Now ALSO ported: closure free-var CAPTURE (lambdas pack their free vars into the
# $Closure env and read them back from the env inside the body — boxed `var`s capture the
# box so mutation is shared), a-data-expr CONSTRUCTOR emission (one table function per
# variant building a $Variant, plus the $variant_names global), the prim-app dispatch
# table (equality/raw-array/type-predicates/string-to-code-point), inline $truthy, and
# singleton constructors as VALUES.  `$raise` is now a real call to the host `raise`
# import: the funcidx space is [host imports ++ runtime ++ lambdas ++ ctors ++ main], so
# imports occupy the lowest indices and every defined-function reference is offset by
# NUM-IMPORTS (centralized in runtime.arr's num-host-imports).  Most runtime kernels are
# still `todo()` stubs, so a compiled module does not RUN end-to-end yet; this emits
# faithful bytes for the structure above.

import encoder as E
import ast-anf as N
import ast as A
import runtime as R

# ===== GC type indices (must match types.ts / runtime.arr's rec-group order) =====
T-LIMBS = 0
T-NUM = 1
T-FIX = 2
T-RAT = 3
T-ROUGH = 4
T-BIG = 5
T-STR = 6
T-FIELDS = 7        # (array (mut anyref)) — also the boxed-var 1-cell
T-VARIANT = 8       # (struct i32 id, (ref $Str) name, (ref $Fields) fields)
T-CLOSURE = 9       # (struct i32 fnIndex, (ref null $Fields) caps)
T-NAMES = 10        # (array (ref $Str))
T-OBJECT = 11       # (struct (ref $Names), (ref $Fields))
T-METHOD = 12       # (struct (ref $Closure))
ANYREF-BT = [list: 110]   # blocktype: single anyref result
I31-HT = 108              # the i31 abstract heaptype byte (== i31ref value-type byte)
EQREF-HT = 109            # the eq abstract heaptype byte (== eqref value-type byte)

# ===== runtime-function indices =====
# The function index space is [HOST IMPORTS ++ runtime fns ++ user lambdas ++ variant
# ctors ++ main]. Imports occupy the lowest funcidxs (wasm requires imports first), so
# EVERY defined-function reference is offset by NUM-IMPORTS. `rt-index(name)` is a runtime
# fn's POSITION in build-runtime(); `rt-funcidx(name)` adds the import offset to get the
# real funcidx for a `call`. Host imports are called by their import index (host-funcidx).
NUM-GC-TYPES = 13
RT-FUNS = R.build-runtime()
NUM-IMPORTS = R.num-host-imports
fun rt-index(name :: String) -> Number: rt-index-from(RT-FUNS, name, 0) end
fun rt-index-from(fs, name :: String, i :: Number) -> Number:
  cases(List) fs:
    | empty => raise("wasm-of-pyret: no runtime fn named " + name)
    | link(f, r) => if f.name == name: i else: rt-index-from(r, name, i + 1) end
  end
end
# real funcidx of a runtime fn (= import block + its position).
fun rt-funcidx(name :: String) -> Number: NUM-IMPORTS + rt-index(name) end
# funcidx of a host import (lives in the low import block; no offset).
fun host-funcidx(name :: String) -> Number: R.host-import-index(name) end
fun idx-make-fix(): rt-funcidx("$make_fix") end
fun idx-make-object(): rt-funcidx("$make_object") end
fun idx-obj-get(): rt-funcidx("$obj_get") end
fun idx-obj-extend(): rt-funcidx("$obj_extend") end
fun idx-variant-field-by-name(): rt-funcidx("$variant_field_by_name") end
fun idx-variant-id(): rt-funcidx("$variant_id") end
fun idx-num-to-i32(): rt-funcidx("$num_to_i32") end

# bools/nothing are i31 (true=1,false=0,nothing=2). $truthy is inlined: cast to i31 then
# i31.get_s, leaving an i32 the `if` consumes (mirrors compile.ts's truthy()).
fun truthy-instr() -> List<Number>: E.ref-cast(I31-HT).append(E.i31-get-s) end
# $raise(ptr,len) host import: host throws a PyretError, never returns. We pass an empty
# message span (0,0) for now (TODO(port): write the real message into scratch memory),
# then `unreachable` so the surrounding (anyref-typed) block still validates.
fun raise-instr() -> List<Number>:
  E.i32-const(0).append(E.i32-const(0)).append(E.i-call(host-funcidx("raise"))).append(E.i-unreachable)
end
# wrap an i32 (0/1) bool on the stack into a Pyret boolean (i31). (mirrors mkBool.)
fun to-bool() -> List<Number>: E.ref-i31 end

# prim-app names the front-end throws for failed control flow (desugar.arr). They abort.
throw-prims :: List<String> = [list:
  "throwNoBranchesMatched", "throwNoCasesMatched", "throwNonBooleanCondition",
  "throwNonBooleanOp", "throwUnfinishedTemplate" ]

# ===== compile context =====
# locals: List<{k; i}> A.Name-key -> wasm local index. vars: keys that are BOXED (a-var)
# so a-id-var/a-assign go through the 1-cell. fenv: reserved. lams: List<{k; i; fvs}>
# lambda-loc-key -> {fnIndex(=table slot); ordered free-var keys}, from collect-lambdas.
# dreg: List<{name; id; arity; fields}> the data registry (variant-name -> global id, field
# count, field names) from collect-data, used by a-cases dispatch + a-data-expr + the
# $variant_names global. gvars: every key bound by an a-var anywhere (names are unique post
# resolve-scope) so capture knows to grab the BOX. nlams: lambda count, so a-data-expr can
# compute a ctor's table slot (= nlams + variant.id).
data Ctx: ctx(locals, next-local :: Number, vars, fenv, lams, dreg, gvars, nlams :: Number) end
fun name-key(n): tostring(n) end          # TODO(port): use A.Name's .key()
fun bind-local(c :: Ctx, key, idx :: Number) -> Ctx:
  ctx(link({k: key, i: idx}, c.locals), num-max(c.next-local, idx + 1), c.vars, c.fenv, c.lams, c.dreg, c.gvars, c.nlams)
end
fun bind-var(c :: Ctx, key, idx :: Number) -> Ctx:
  ctx(link({k: key, i: idx}, c.locals), num-max(c.next-local, idx + 1), link(key, c.vars), c.fenv, c.lams, c.dreg, c.gvars, c.nlams)
end
fun is-var(c :: Ctx, key) -> Boolean: c.vars.member(key) end
fun lookup-local-opt(c :: Ctx, key):
  find-pair-opt(c.locals, key)
end
fun find-pair-opt(ps, key):
  cases(List) ps:
    | empty => none
    | link(f, r) => if f.k == key: some(f.i) else: find-pair-opt(r, key) end
  end
end
fun lookup-local(c :: Ctx, key) -> Number:
  cases(Option) lookup-local-opt(c, key):
    | none => raise("wasm-of-pyret: unbound local " + key)
    | some(i) => i
  end
end
# top-level/global resolution: the `fenv` Ctx slot carries the global map
# (List<{k; gi}>: top-level binding key -> wasm global index). Top-level bindings are
# mirrored into mutable anyref globals so lambdas (which do NOT capture top-level names)
# resolve them by global.get — enabling forward/mutually-recursive top-level reference.
fun gmap-lookup(c :: Ctx, key):
  find-gi(c.fenv, key)
end
fun find-gi(ps, key):
  cases(List) ps:
    | empty => none
    | link(f, r) => if f.k == key: some(f.gi) else: find-gi(r, key) end
  end
end
# resolve an id that is NOT a local: global.get if top-level, else null. (TODO(port):
# module-qualified refs.)
fun resolve-nonlocal(c :: Ctx, key) -> List<Number>:
  cases(Option) gmap-lookup(c, key):
    | some(gi) => E.global-get(gi)
    | none => E.i-ref-null(110)
  end
end
# if `key` is a top-level global, mirror the just-bound local `idx` into it.
fun mirror-global(c :: Ctx, key, idx :: Number) -> List<Number>:
  cases(Option) gmap-lookup(c, key):
    | none => empty
    | some(gi) => E.local-get(idx).append(E.global-set(gi))
  end
end
# variant-name -> {id; arity; fields} option, from the data registry.
fun data-lookup(c :: Ctx, name :: String): dreg-find(c.dreg, name) end
fun dreg-find(ds, name :: String):
  cases(List) ds:
    | empty => none
    | link(f, r) => if f.name == name: some(f) else: dreg-find(r, name) end
  end
end
# lambda-loc-key -> its collected {k; i(fnIndex); fvs}.
fun lookup-lam-pair(ps, key):
  cases(List) ps:
    | empty => raise("wasm-of-pyret: lambda not collected " + key)
    | link(f, r) => if f.k == key: f else: lookup-lam-pair(r, key) end
  end
end

# ===== free-var analysis (for closure capture) =====
# fv-* return ordered, de-duplicated lists of A.Name keys referenced but not bound within.
fun fv-union(a, b):
  cases(List) b:
    | empty => a
    | link(f, r) => fv-union(if a.member(f): a else: a.append([list: f]) end, r)
  end
end
fun fv-subtract(a, ks): a.filter(lam(x): not(ks.member(x)) end) end
fun fv-val(v):
  cases(N.AVal) v:
    | a-id(_, id) => [list: name-key(id)]
    | a-id-safe-letrec(_, id) => [list: name-key(id)]
    | else => empty
  end
end
fun fv-vals(vs):
  cases(List) vs:
    | empty => empty
    | link(f, r) => fv-union(fv-val(f), fv-vals(r))
  end
end
fun fv-fields(fields): fv-vals(fields.map(lam(f): f.value end)) end
fun arg-keys(args): args.map(lam(a): name-key(a.id) end) end
fun branch-arg-keys(br):
  cases(N.ACasesBranch) br:
    | a-cases-branch(_, _, _, args, _) => args.map(lam(cb): name-key(cb.bind.id) end)
    | a-singleton-cases-branch(_, _, _, _) => empty
  end
end
fun fv-branches(branches):
  cases(List) branches:
    | empty => empty
    | link(br, r) =>
      fv-union(fv-subtract(fv-expr(branch-body(br)), branch-arg-keys(br)), fv-branches(r))
  end
end
fun fv-lettable(lt):
  cases(N.ALettable) lt:
    | a-val(_, v) => fv-val(v)
    | a-id-var(_, id) => [list: name-key(id)]
    | a-id-letrec(_, id, _) => [list: name-key(id)]
    | a-id-var-modref(_, _, _, _) => empty
    | a-app(_, f, args, _) => fv-union(fv-val(f), fv-vals(args))
    | a-prim-app(_, _, args, _) => fv-vals(args)
    | a-if(_, cnd, t, e) => fv-union(fv-val(cnd), fv-union(fv-expr(t), fv-expr(e)))
    | a-lam(_, _, args, _, body) => fv-subtract(fv-expr(body), arg-keys(args))
    | a-method(_, _, args, _, body) => fv-subtract(fv-expr(body), arg-keys(args))
    | a-obj(_, fields) => fv-fields(fields)
    | a-extend(_, supe, fields) => fv-union(fv-val(supe), fv-fields(fields))
    | a-update(_, supe, fields) => fv-union(fv-val(supe), fv-fields(fields))
    | a-dot(_, obj, _) => fv-val(obj)
    | a-colon(_, obj, _) => fv-val(obj)
    | a-get-bang(_, obj, _) => fv-val(obj)
    | a-tuple(_, fields) => fv-vals(fields)
    | a-tuple-get(_, tup, _) => fv-val(tup)
    | a-cases(_, _, val, branches, els) => fv-union(fv-val(val), fv-union(fv-expr(els), fv-branches(branches)))
    | a-assign(_, id, value) => fv-union([list: name-key(id)], fv-val(value))
    | a-method-app(_, obj, _, args) => fv-union(fv-val(obj), fv-vals(args))
    | a-data-expr(_, _, _, _, _) => empty   # TODO(port): with-members/shared free vars
    | a-ref(_, _) => empty
    | a-module(_, _, _, _, _, _, _) => empty
  end
end
fun fv-expr(e):
  cases(N.AExpr) e:
    | a-let(_, b, lt, body) => fv-union(fv-lettable(lt), fv-subtract(fv-expr(body), [list: name-key(b.id)]))
    | a-var(_, b, lt, body) => fv-union(fv-lettable(lt), fv-subtract(fv-expr(body), [list: name-key(b.id)]))
    | a-seq(_, e1, e2) => fv-union(fv-lettable(e1), fv-expr(e2))
    | a-lettable(_, lt) => fv-lettable(lt)
    | a-type-let(_, _, body) => fv-expr(body)
    | a-arr-let(_, b, _, lt, body) => fv-union(fv-lettable(lt), fv-subtract(fv-expr(body), [list: name-key(b.id)]))
  end
end
fun fv-of-lam(args, body): fv-subtract(fv-expr(body), arg-keys(args)) end

# ===== a $Str (array i8) from a Pyret string's code points =====
fun emit-str(s :: String) -> List<Number>:
  cps = string-to-code-points(s)
  E.concat(cps.map(lam(cp): E.i32-const(cp) end)).append(E.array-new-fixed(T-STR, length(cps)))
end
# read the boxed-var 1-cell at local `idx` -> its value
fun box-read(idx :: Number) -> List<Number>:
  E.local-get(idx).append(E.i32-const(0)).append(E.array-get(T-FIELDS))
end
# load a free var's CURRENT value at a capture site: just local-get its local. For a `var`
# that local already holds the 1-cell BOX, so the box (not the value) is captured -> shared
# mutation. A name not bound as a local (e.g. a top-level def) captures as null. TODO(port).
fun load-capture(c :: Ctx, key) -> List<Number>:
  cases(Option) lookup-local-opt(c, key):
    | none => E.i-ref-null(110)
    | some(i) => E.local-get(i)
  end
end

# ===== AVal -> instructions (leaves one anyref on the stack) =====
fun compile-aval(v, c :: Ctx) -> List<Number>:
  cases(N.AVal) v:
    | a-num(l, n) =>
      # exact small ints -> $make_fix(i64). TODO(port): rationals/roughnums/bignum literals.
      E.i64-const(n).append(E.i-call(idx-make-fix()))
    | a-str(l, s) => emit-str(s)
    | a-bool(l, b) => E.i32-const(if b: 1 else: 0 end).append(E.ref-i31)
    | a-id(l, id) =>
      k = name-key(id)
      cases(Option) lookup-local-opt(c, k):
        | none => resolve-nonlocal(c, k)                                     # top-level global, else null
        | some(i) => if is-var(c, k): box-read(i) else: E.local-get(i) end
      end
    | a-srcloc(l, loc) => E.i-ref-null(110)                                  # TODO(port): srcloc value
    | a-undefined(l) => E.i-ref-null(110)
    | a-prim-val(l, name) => E.i-ref-null(110)                              # TODO(port): primitive globals
  end
end

fun compile-avals(vs, c :: Ctx) -> List<Number>:
  E.concat(vs.map(lam(v): compile-aval(v, c) end))
end
# pack a list of already-on-stack values into a $Fields array (caller pushed them)
fun pack-fields(vs, c :: Ctx) -> List<Number>:
  compile-avals(vs, c).append(E.array-new-fixed(T-FIELDS, length(vs)))
end
# a $Names array of $Str from field records (each with .name)
fun emit-names(flds) -> List<Number>:
  E.concat(flds.map(lam(f): emit-str(f.name) end)).append(E.array-new-fixed(T-NAMES, length(flds)))
end
# a $Names array from a plain list of field-name strings
fun emit-names-of(names) -> List<Number>:
  E.concat(names.map(lam(nm): emit-str(nm) end)).append(E.array-new-fixed(T-NAMES, length(names)))
end

# ===== prim-app dispatch =====
# Mirrors the seed's intrinsic ladder (compile.ts buildPrimApp): the raw-array library,
# value-model type predicates, equality, and string-to-code-point lower to inline GC ops +
# runtime calls; control-flow throw-prims and the unmapped tail call the $raise host import.
# Each branch leaves ONE anyref on the stack.  Args are $Num/anyref AVals.
fun prim-type-test(args, c :: Ctx, t :: Number) -> List<Number>:
  compile-aval(args.first, c).append(E.ref-test-null(t)).append(to-bool())
end
fun compile-prim-app(fname :: String, args, c :: Ctx) -> List<Number>:
  ask:
    # ---- equality ----
    | (fname == "equal-always") or (fname == "equal-now") then:
      compile-avals(args, c).append(E.i-call(rt-funcidx("$equal"))).append(to-bool())
    | fname == "identical" then:
      compile-aval(args.first, c).append(E.ref-cast(EQREF-HT))
        .append(compile-aval(args.rest.first, c)).append(E.ref-cast(EQREF-HT))
        .append(E.ref-eq).append(to-bool())
    | fname == "not" then:
      compile-aval(args.first, c).append(truthy-instr()).append(E.i32-eqz).append(to-bool())
    # ---- raw arrays = a $Fields (array (mut anyref)) ----
    | (fname == "raw-array-get") or (fname == "prim-raw-array-get") then:
      compile-aval(args.first, c).append(E.ref-cast(T-FIELDS))
        .append(compile-aval(args.rest.first, c)).append(E.i-call(idx-num-to-i32()))
        .append(E.array-get(T-FIELDS))
    | (fname == "raw-array-length") or (fname == "prim-raw-array-length") then:
      compile-aval(args.first, c).append(E.ref-cast(T-FIELDS)).append(E.array-len)
        .append(E.i64-extend-i32-u).append(E.i-call(idx-make-fix()))
    | (fname == "raw-array-set") or (fname == "prim-raw-array-set") then:
      a = c.next-local                                  # stash array; assignment returns it
      compile-aval(args.first, c).append(E.local-set(a))
        .append(E.local-get(a)).append(E.ref-cast(T-FIELDS))
        .append(compile-aval(args.rest.first, c)).append(E.i-call(idx-num-to-i32()))
        .append(compile-aval(args.rest.rest.first, c))
        .append(E.array-set(T-FIELDS))
        .append(E.local-get(a))
    | (fname == "raw-array-of") or (fname == "prim-raw-array-of") then:
      # array.new $Fields : [init, i32 count] -> arrayref  (init = elt, count = n)
      compile-aval(args.first, c)
        .append(compile-aval(args.rest.first, c)).append(E.i-call(idx-num-to-i32()))
        .append(E.array-new(T-FIELDS))
    # ---- the byte code point of a 1-char string ----
    | fname == "string-to-code-point" then:
      compile-aval(args.first, c).append(E.ref-cast(T-STR))
        .append(E.i32-const(0)).append(E.array-get-u(T-STR))
        .append(E.i64-extend-i32-u).append(E.i-call(idx-make-fix()))
    # ---- value-model type predicates (ref.test the runtime representation) ----
    | fname == "is-string" then: prim-type-test(args, c, T-STR)
    | fname == "is-number" then: prim-type-test(args, c, T-NUM)
    | fname == "is-function" then: prim-type-test(args, c, T-CLOSURE)
    | fname == "is-object" then: prim-type-test(args, c, T-OBJECT)
    | fname == "is-raw-array" then: prim-type-test(args, c, T-FIELDS)
    # ---- control-flow aborts + the unmapped tail -> $raise host import ----
    | throw-prims.member(fname) then: raise-instr()
    | otherwise: raise-instr()   # TODO(port): makeArrayN, getMaker*, getColonField, getBracket, makeSome/None, run-task...
  end
end

# ===== ALettable -> instructions (leaves the value; `tail` => return_call) =====
fun compile-lettable(lt, c :: Ctx, tail :: Boolean) -> List<Number>:
  cases(N.ALettable) lt:
    | a-val(l, v) => compile-aval(v, c)
    | a-id-var(l, id) =>
      k = name-key(id)
      cases(Option) lookup-local-opt(c, k):
        | none => resolve-nonlocal(c, k)
        | some(i) => if is-var(c, k): box-read(i) else: E.local-get(i) end
      end
    | a-id-letrec(l, id, safe) =>
      k = name-key(id)
      cases(Option) lookup-local-opt(c, k):
        | none => resolve-nonlocal(c, k)
        | some(i) => E.local-get(i)
      end
    | a-id-var-modref(l, id, uri, name) => E.i-ref-null(110)                # TODO(port): module ref
    | a-app(l, f, args, info) =>
      # closure-calling convention: (closure-as-anyref, $Fields)->anyref via table 0.
      # The closure is used twice (passed as arg0 AND its fnIndex is the table selector),
      # so stash it in a temp local. Stack order for call_indirect: [arg0=closure,
      # arg1=fields, selector=closure.fnIndex].  tyidx = the closure-call func type.
      cl = c.next-local
      tyidx = closure-call-type-idx()
      compile-aval(f, c)
        .append(E.local-set(cl))
        .append(E.local-get(cl))                                  # arg0: the closure
        .append(pack-fields(args, c))                             # arg1: args as $Fields
        .append(E.local-get(cl)).append(E.ref-cast(T-CLOSURE)).append(E.struct-get(T-CLOSURE, 0))  # selector
        .append(if tail: E.i-return-call-indirect(tyidx, 0) else: E.i-call-indirect(tyidx, 0) end)
    | a-prim-app(l, fname, args, info) => compile-prim-app(fname, args, c)
    | a-if(l, cnd, t, e) =>
      compile-aval(cnd, c)
        .append(truthy-instr())
        .append(E.i-if(ANYREF-BT))
        .append(compile-aexpr(t, c, tail))
        .append(E.i-else)
        .append(compile-aexpr(e, c, tail))
        .append(E.i-end)
    | a-lam(l, name, args, ret, body) =>
      # closure value: struct.new $Closure {fnIndex, caps}.  fnIndex is the table slot the
      # collect-lambdas pass assigned this lambda; caps is its free vars packed into a
      # $Fields (read back inside the body from local 0). Closed lambdas get an empty caps.
      p = lookup-lam-pair(c.lams, tostring(l))
      caps = E.concat(p.fvs.map(lam(k): load-capture(c, k) end)).append(E.array-new-fixed(T-FIELDS, length(p.fvs)))
      E.i32-const(p.i).append(caps).append(E.struct-new(T-CLOSURE))
    | a-method(l, name, args, ret, body) =>
      p = lookup-lam-pair(c.lams, tostring(l))
      caps = E.concat(p.fvs.map(lam(k): load-capture(c, k) end)).append(E.array-new-fixed(T-FIELDS, length(p.fvs)))
      E.i32-const(p.i).append(caps).append(E.struct-new(T-CLOSURE)).append(E.struct-new(T-METHOD))
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
      # vtag dispatch: stash val + its variant-id in temps, then a nested if-chain per
      # branch comparing the id (from the data registry); each matching branch binds its
      # args from the variant's $Fields by index, then runs its body; final else.
      vtmp = c.next-local
      idtmp = c.next-local + 1
      c2 = ctx(c.locals, c.next-local + 2, c.vars, c.fenv, c.lams, c.dreg, c.gvars, c.nlams)   # reserve 2 temps
      compile-aval(val, c)
        .append(E.local-set(vtmp))
        .append(E.local-get(vtmp)).append(E.i-call(idx-variant-id())).append(E.local-set(idtmp))
        .append(compile-branches(branches, vtmp, idtmp, c2, tail, els))
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
      # the variant registry (id/arity/fields) is collected up front (collect-data, in
      # Ctx.dreg); the per-variant constructor FUNCTIONS are emitted by the assembler into
      # the table (ctor table slot = nlams + variant.id). Here we return the data value as
      # an $Object mapping each variant name -> its constructor closure, so later code can
      # reach the constructors. The $variant_names global (for $variant_field_by_name) is
      # built by the assembler from the same registry.
      # Singleton variants bind to their constructed VALUE; regular variants bind to a
      # constructor closure (see data-field-value). TODO(port): is-<variant> predicates and
      # binding the constructor names that the front-end's ANF references directly (needs
      # the top-level/global id resolution that a-id still leaves as null).
      this-names = variants.map(variant-name)
      emit-names-of(this-names)
        .append(E.concat(variants.map(lam(vv): data-field-value(c, vv) end)))
        .append(E.array-new-fixed(T-FIELDS, length(variants)))
        .append(E.i-call(idx-make-object()))
    | a-ref(l, ann) => E.i-ref-null(110)                                   # TODO(port): bare ref
    | a-module(l, ans, dv, dt, prov, types, checks) => E.i-ref-null(110)   # TODO(port): module value
  end
end

# the constructor closure for a variant: struct.new $Closure {table-slot, null caps}.
# table-slot = nlams + the variant's registry id (the assembler lays ctors after lambdas).
fun ctor-closure(c :: Ctx, v) -> List<Number>:
  vn = variant-name(v)
  cases(Option) data-lookup(c, vn):
    | none => E.i-ref-null(T-CLOSURE)
    | some(d) => E.i32-const(c.nlams + d.id).append(E.i-ref-null(T-FIELDS)).append(E.struct-new(T-CLOSURE))
  end
end
# the value bound to a variant name in the data object: a SINGLETON variant is the
# constructed $Variant VALUE (no args, so it's used directly, not called); a regular
# variant is its constructor closure.
fun data-field-value(c :: Ctx, v) -> List<Number>:
  vn = variant-name(v)
  cases(N.AVariant) v:
    | a-singleton-variant(_, _, _) =>
      cases(Option) data-lookup(c, vn):
        | none => E.i-ref-null(110)
        | some(d) =>
          E.i32-const(d.id).append(emit-str(d.name))
            .append(E.array-new-fixed(T-FIELDS, 0)).append(E.struct-new(T-VARIANT))
      end
    | a-variant(_, _, _, _, _) => ctor-closure(c, v)
  end
end
fun variant-name(v) -> String:
  cases(N.AVariant) v:
    | a-variant(_, _, nm, _, _) => nm
    | a-singleton-variant(_, nm, _) => nm
  end
end

# prim-app -> runtime index. (kept for reference; the dispatch lives inline in a-prim-app.)

# ===== a-cases branch chain =====
# Build a nested if/else over the variant id (in local `idtmp`), val in local `vtmp`.
fun compile-branches(branches, vtmp :: Number, idtmp :: Number, c :: Ctx, tail :: Boolean, els) -> List<Number>:
  cases(List) branches:
    | empty => compile-aexpr(els, c, tail)
    | link(br, rest) =>
      cases(N.ACasesBranch) br:
        | a-cases-branch(_, _, bname, bargs, bbody) =>
          cases(Option) data-lookup(c, bname):
            | none => compile-branches(rest, vtmp, idtmp, c, tail, els)     # unknown variant: skip
            | some(d) =>
              bound = bind-cases-args(bargs, 0, vtmp, c, empty)
              E.local-get(idtmp).append(E.i32-const(d.id)).append(E.i32-eq)
                .append(E.i-if(ANYREF-BT))
                .append(bound.code).append(compile-aexpr(bbody, bound.cx, tail))
                .append(E.i-else)
                .append(compile-branches(rest, vtmp, idtmp, c, tail, els))
                .append(E.i-end)
          end
        | a-singleton-cases-branch(_, _, bname, bbody) =>
          cases(Option) data-lookup(c, bname):
            | none => compile-branches(rest, vtmp, idtmp, c, tail, els)
            | some(d) =>
              E.local-get(idtmp).append(E.i32-const(d.id)).append(E.i32-eq)
                .append(E.i-if(ANYREF-BT))
                .append(compile-aexpr(bbody, c, tail))
                .append(E.i-else)
                .append(compile-branches(rest, vtmp, idtmp, c, tail, els))
                .append(E.i-end)
          end
      end
  end
end

# Bind a branch's args from val's $Fields by index into fresh locals; returns
# { code: prologue-instrs, cx: extended-ctx }.
fun bind-cases-args(args, j :: Number, vtmp :: Number, c :: Ctx, code):
  cases(List) args:
    | empty => { code: code, cx: c }
    | link(cb, rest) =>
      slot = c.next-local
      k = name-key(cb.bind.id)
      c2 = bind-local(c, k, slot)
      step = E.local-get(vtmp)
        .append(E.ref-cast(T-VARIANT))
        .append(E.struct-get(T-VARIANT, 2))   # the $Fields
        .append(E.i32-const(j))
        .append(E.array-get(T-FIELDS))
        .append(E.local-set(slot))
      bind-cases-args(rest, j + 1, vtmp, c2, code.append(step))
  end
end

# ===== AExpr -> instructions =====
fun compile-aexpr(e, c :: Ctx, tail :: Boolean) -> List<Number>:
  cases(N.AExpr) e:
    | a-let(l, b, lt, body) =>
      idx = c.next-local
      k = name-key(b.id)
      compile-lettable(lt, c, false)
        .append(E.local-set(idx))
        .append(mirror-global(c, k, idx))                 # top-level: also set the global
        .append(compile-aexpr(body, bind-local(c, k, idx), tail))
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
      k = name-key(b.id)
      compile-lettable(lt, c, false)
        .append(E.local-set(slot))
        .append(mirror-global(c, k, slot))
        .append(compile-aexpr(body, bind-local(c, k, slot), tail))
  end
end

# ===== pre-pass: collect lambdas (so each gets a stable fnIndex/table slot) =====
# Walk the whole program collecting every a-lam/a-method in source order. Each record:
# { key: loc-string, args, body, fvs: ordered free-var keys }. fnIndex == position.
fun collect-lams-expr(e, acc):
  cases(N.AExpr) e:
    | a-let(_, _, lt, body) => collect-lams-expr(body, collect-lams-lettable(lt, acc))
    | a-var(_, _, lt, body) => collect-lams-expr(body, collect-lams-lettable(lt, acc))
    | a-seq(_, e1, e2) => collect-lams-expr(e2, collect-lams-lettable(e1, acc))
    | a-lettable(_, lt) => collect-lams-lettable(lt, acc)
    | a-type-let(_, _, body) => collect-lams-expr(body, acc)
    | a-arr-let(_, _, _, lt, body) => collect-lams-expr(body, collect-lams-lettable(lt, acc))
  end
end
fun collect-lams-lettable(lt, acc):
  cases(N.ALettable) lt:
    | a-lam(l, _, args, _, body) => collect-lams-expr(body, link({key: tostring(l), args: args, body: body, fvs: fv-of-lam(args, body)}, acc))
    | a-method(l, _, args, _, body) => collect-lams-expr(body, link({key: tostring(l), args: args, body: body, fvs: fv-of-lam(args, body)}, acc))
    | a-if(_, _, t, e) => collect-lams-expr(e, collect-lams-expr(t, acc))
    | a-cases(_, _, _, branches, els) =>
      for fold(a from collect-lams-expr(els, acc), br from branches):
        collect-lams-expr(branch-body(br), a)
      end
    | else => acc
  end
end
fun branch-body(br):
  cases(N.ACasesBranch) br:
    | a-cases-branch(_, _, _, _, body) => body
    | a-singleton-cases-branch(_, _, _, body) => body
  end
end

# ===== pre-pass: every key bound by an a-var (so captures grab the box) =====
fun collect-gvars-expr(e, acc):
  cases(N.AExpr) e:
    | a-let(_, _, lt, body) => collect-gvars-expr(body, collect-gvars-lettable(lt, acc))
    | a-var(_, b, lt, body) => collect-gvars-expr(body, collect-gvars-lettable(lt, link(name-key(b.id), acc)))
    | a-seq(_, e1, e2) => collect-gvars-expr(e2, collect-gvars-lettable(e1, acc))
    | a-lettable(_, lt) => collect-gvars-lettable(lt, acc)
    | a-type-let(_, _, body) => collect-gvars-expr(body, acc)
    | a-arr-let(_, _, _, lt, body) => collect-gvars-expr(body, collect-gvars-lettable(lt, acc))
  end
end
fun collect-gvars-lettable(lt, acc):
  cases(N.ALettable) lt:
    | a-lam(_, _, _, _, body) => collect-gvars-expr(body, acc)
    | a-method(_, _, _, _, body) => collect-gvars-expr(body, acc)
    | a-if(_, _, t, e) => collect-gvars-expr(e, collect-gvars-expr(t, acc))
    | a-cases(_, _, _, branches, els) =>
      for fold(a from collect-gvars-expr(els, acc), br from branches):
        collect-gvars-expr(branch-body(br), a)
      end
    | else => acc
  end
end

# ===== pre-pass: collect the data registry (variant-name -> {id; arity; fields}) =====
# Global, unique variant ids assigned in encounter order, used by a-cases dispatch,
# a-data-expr constructors, and the $variant_names global.
fun variant-member-name(m) -> String:
  cases(N.AVariantMember) m:
    | a-variant-member(_, _, bind) => name-key(bind.id)
  end
end
fun collect-data-expr(e, acc):
  cases(N.AExpr) e:
    | a-let(_, _, lt, body) => collect-data-expr(body, collect-data-lettable(lt, acc))
    | a-var(_, _, lt, body) => collect-data-expr(body, collect-data-lettable(lt, acc))
    | a-seq(_, e1, e2) => collect-data-expr(e2, collect-data-lettable(e1, acc))
    | a-lettable(_, lt) => collect-data-lettable(lt, acc)
    | a-type-let(_, _, body) => collect-data-expr(body, acc)
    | a-arr-let(_, _, _, lt, body) => collect-data-expr(body, collect-data-lettable(lt, acc))
  end
end
fun collect-data-lettable(lt, acc):
  cases(N.ALettable) lt:
    | a-data-expr(_, _, _, variants, _) =>
      for fold(a from acc, v from variants):
        cases(N.AVariant) v:
          | a-variant(_, _, vname, members, _) =>
            link({name: vname, id: length(a), arity: length(members), fields: members.map(variant-member-name)}, a)
          | a-singleton-variant(_, vname, _) =>
            link({name: vname, id: length(a), arity: 0, fields: empty}, a)
        end
      end
    | a-if(_, _, t, e) => collect-data-expr(e, collect-data-expr(t, acc))
    | a-lam(_, _, _, _, body) => collect-data-expr(body, acc)
    | a-method(_, _, _, _, body) => collect-data-expr(body, acc)
    | a-cases(_, _, _, branches, els) =>
      for fold(a from collect-data-expr(els, acc), br from branches):
        collect-data-expr(branch-body(br), a)
      end
    | else => acc
  end
end
# the registry in id order (ids are dense 0..n-1).
fun ctors-by-id(dreg, i :: Number, n :: Number):
  if i == n: empty
  else: link(find-by-id(dreg, i), ctors-by-id(dreg, i + 1, n)) end
end
fun find-by-id(ds, target :: Number):
  cases(List) ds:
    | empty => raise("wasm-of-pyret: no variant with id " + tostring(target))
    | link(f, r) => if f.id == target: f else: find-by-id(r, target) end
  end
end

# ===== the GC type rec-group (must match types.ts / runtime.arr's layout) =====
fun gc-rec-group():
  i32f = E.field(E.i32t, 0)
  E.rec-group([list:
    E.array-type(E.field(E.i32t, 1)),                                                  # 0  $Limbs (mut i32)
    E.sub-type(empty, E.struct-type([list: i32f])),                                    # 1  $Num (open base)
    E.sub-type([list: 1], E.struct-type([list: i32f, E.field(E.i64t, 0)])),            # 2  $Fixnum
    E.sub-type([list: 1], E.struct-type([list: i32f, E.field(E.reft(1), 0), E.field(E.reft(1), 0)])),  # 3  $Rational
    E.sub-type([list: 1], E.struct-type([list: i32f, E.field(E.f64t, 0)])),            # 4  $Roughnum
    E.sub-type([list: 1], E.struct-type([list: i32f, i32f, E.field(E.reft(0), 0)])),   # 5  $Bignum
    E.array-type(E.field(E.i8st, 1)),                                                  # 6  $Str (mut i8)
    E.array-type(E.field(E.anyref, 1)),                                                # 7  $Fields (mut anyref)
    E.struct-type([list: i32f, E.field(E.reft(6), 0), E.field(E.reft(7), 0)]),         # 8  $Variant
    E.struct-type([list: i32f, E.field(E.reftnull(7), 0)]),                            # 9  $Closure
    E.array-type(E.field(E.reft(6), 0)),                                               # 10 $Names
    E.struct-type([list: E.field(E.reft(10), 0), E.field(E.reft(7), 0)]),              # 11 $Object
    E.struct-type([list: E.field(E.reft(9), 0)]) ])                                    # 12 $Method
end

# type index of the closure-call func type ((closure-as-anyref, $Fields)->anyref): it
# follows the GC rec-group (NUM-GC-TYPES indices) and one func type per runtime fn.
fun closure-call-type-idx(): NUM-GC-TYPES + length(RT-FUNS) end
fun main-type-idx(): NUM-GC-TYPES + length(RT-FUNS) + 1 end
# the host-import func types follow closure-call + main in the type section.
fun import-type-base(): NUM-GC-TYPES + length(RT-FUNS) + 2 end
fun import-type-idx(k :: Number): import-type-base() + k end

LOCAL-BUDGET = 512   # anyref locals declared per function (over-declared; unused are legal)

# assign each collected lambda its fnIndex (== source position) -> List<{k; i; fvs}>
fun index-pairs(items, i :: Number, acc):
  cases(List) items:
    | empty => acc.reverse()
    | link(f, r) => index-pairs(r, i + 1, link({k: f.key, i: i, fvs: f.fvs}, acc))
  end
end

# compile one lambda to a code entry: caps (free vars from the closure env, local 0) and
# args (from the $Fields param, local 1) are loaded into fresh locals, then the body in
# tail position.  A captured `var` is re-bound as a var so reads/writes go through the box.
fun compile-lam(lr, lam-map, dreg, gvars, nlams :: Number, gmap) -> List<Number>:
  c0 = ctx(empty, 2, empty, gmap, lam-map, dreg, gvars, nlams)
  capres = bind-caps(lr.fvs, 0, c0, empty)
  argres = setup-args(lr.args, capres.cx, capres.code, 0)
  body-code = compile-aexpr(lr.body, argres.cx, true)
  E.code-entry([list: E.local-decl(LOCAL-BUDGET, E.anyref)], argres.code.append(body-code))
end
# load each captured free var out of the closure env (local 0 -> $Closure.caps[j]).
fun bind-caps(fvs, j :: Number, c :: Ctx, code):
  cases(List) fvs:
    | empty => { code: code, cx: c }
    | link(k, rest) =>
      slot = c.next-local
      c2 = if c.gvars.member(k): bind-var(c, k, slot) else: bind-local(c, k, slot) end
      step = E.local-get(0)
        .append(E.ref-cast(T-CLOSURE))
        .append(E.struct-get(T-CLOSURE, 1))   # caps $Fields
        .append(E.i32-const(j))
        .append(E.array-get(T-FIELDS))
        .append(E.local-set(slot))
      bind-caps(rest, j + 1, c2, code.append(step))
  end
end
# copy args out of the $Fields param (local 1) by position into fresh locals.
fun setup-args(args, c :: Ctx, code, argi :: Number):
  cases(List) args:
    | empty => { code: code, cx: c }
    | link(ab, rest) =>
      slot = c.next-local
      c2 = bind-local(c, name-key(ab.id), slot)
      step = E.local-get(1).append(E.i32-const(argi)).append(E.array-get(T-FIELDS)).append(E.local-set(slot))
      setup-args(rest, c2, code.append(step), argi + 1)
  end
end
# compile one variant constructor: receives args as $Fields (local 1); builds the
# $Variant {id, name, fields=local1} and returns it.
fun compile-ctor(d) -> List<Number>:
  body = E.i32-const(d.id).append(emit-str(d.name)).append(E.local-get(1)).append(E.struct-new(T-VARIANT))
  E.code-entry([list: E.local-decl(LOCAL-BUDGET, E.anyref)], body)
end
# $variant_names global = (ref $Fields) of $Names, indexed by variant id, so
# $variant_field_by_name can scan a variant's field names. Built from the registry.
fun variant-names-init(ordered) -> List<Number>:
  E.concat(ordered.map(lam(d): emit-names-of(d.fields) end)).append(E.array-new-fixed(T-FIELDS, length(ordered)))
end

# ===== pre-pass: top-level binding keys (mirrored to globals) =====
# Walk the a-let/a-arr-let/a-seq spine of the program body, collecting the keys bound
# at the TOP LEVEL. These become mutable anyref globals so lambdas resolve them by
# global.get (instead of capturing), supporting forward/mutual top-level reference.
# (a-var top-level bindings are left local-only: their box semantics don't map cleanly
# to a value global — TODO(port).)
fun collect-toplevel(e, acc):
  cases(N.AExpr) e:
    | a-let(_, b, _, body) => collect-toplevel(body, link(name-key(b.id), acc))
    | a-arr-let(_, b, _, _, body) => collect-toplevel(body, link(name-key(b.id), acc))
    | a-var(_, _, _, body) => collect-toplevel(body, acc)
    | a-seq(_, _, e2) => collect-toplevel(e2, acc)
    | a-type-let(_, _, body) => collect-toplevel(body, acc)
    | else => acc
  end
end

# ===== program assembler =====
# main sets $link_id/$empty_id from List's link/empty variant ids (looked up in the data
# registry) so the renderer shows lists as [list: ...] and $cons/$empty_list build
# well-formed variants. If the program defines no such variant, the global stays -1.
fun gid-init(dreg, name :: String, gi :: Number) -> List<Number>:
  cases(Option) dreg-find(dreg, name):
    | none => empty
    | some(d) => E.i32-const(d.id).append(E.global-set(gi))
  end
end

fun compile-prog(prog) -> List<Number>:
  cases(N.AProg) prog:
    | a-program(l, provides, imports, body) =>
      lams-raw = collect-lams-expr(body, empty).reverse()   # source order
      dreg = collect-data-expr(body, empty)                 # registry (ids by encounter)
      gvars = collect-gvars-expr(body, empty)               # a-var-bound keys
      num-rt = length(RT-FUNS)
      num-ctors = length(dreg)
      ordered = ctors-by-id(dreg, 0, num-ctors)             # ctors in id order
      # globals: [runtime block 0..NUM-RT-GLOBALS-1][$variant_names?][top-level...].
      # top-level globals follow the runtime block and $variant_names (when variants exist).
      gbase = R.NUM-RT-GLOBALS + (if num-ctors == 0: 0 else: 1 end)
      tl-keys = collect-toplevel(body, empty).reverse()
      num-tl = length(tl-keys)
      gmap = map2(lam(k, gi): {k: k, gi: gbase + gi} end, tl-keys, range(0, num-tl))
      # top-level names are resolved via globals, so DON'T capture them into closures.
      lams = lams-raw.map(lam(lr): {key: lr.key, args: lr.args, body: lr.body, fvs: fv-subtract(lr.fvs, tl-keys)} end)
      lam-map = index-pairs(lams, 0, empty)
      num-lams = length(lams)
      # funcidx space: [imports 0..NUM-IMPORTS-1][runtime][lambdas][ctors][main].
      main-funcidx = NUM-IMPORTS + (((num-rt + num-lams) + num-ctors))

      # ----- main (() -> anyref), the lambda bodies, and the ctor bodies -----
      main-ctx = ctx(empty, 0, empty, gmap, lam-map, dreg, gvars, num-lams)
      # set $link_id/$empty_id from the data registry before running the program body.
      list-id-init = gid-init(dreg, "link", R.GI-LINK-ID).append(gid-init(dreg, "empty", R.GI-EMPTY-ID))
      main-code = E.code-entry([list: E.local-decl(LOCAL-BUDGET, E.anyref)],
        list-id-init.append(compile-aexpr(body, main-ctx, true)))
      lam-code = lams.map(lam(lr): compile-lam(lr, lam-map, dreg, gvars, num-lams, gmap) end)
      ctor-code = ordered.map(lam(d): compile-ctor(d) end)
      # runtime bodies already end with `end`, so build their code entries raw (code-entry
      # would append a second `end`).
      rt-code = RT-FUNS.map(lam(rf): E.byte-vec(E.vec(rf.locals).append(rf.body)) end)

      # ----- type section: GC rec-group ++ a func type per runtime fn ++ closure ++ main
      #       ++ one func type per host import (referenced by the import section) -----
      rt-types = RT-FUNS.map(lam(rf): E.func-type-vt(rf.params, rf.results) end)
      closure-type = E.func-type-vt([list: E.anyref, E.reftnull(T-FIELDS)], [list: E.anyref])
      main-type = E.func-type-vt(empty, [list: E.anyref])
      import-types = R.host-imports.map(lam(hi): E.func-type-vt(hi.params, hi.results) end)
      type-c = E.vec(link(gc-rec-group(), rt-types.append([list: closure-type, main-type]).append(import-types)))

      # ----- func section: a type index per function (runtime ++ lambdas ++ ctors ++ main) -----
      rt-func-decls = range(0, num-rt).map(lam(i): E.leb-u(NUM-GC-TYPES + i) end)
      lam-func-decls = range(0, num-lams).map(lam(_): E.leb-u(closure-call-type-idx()) end)
      ctor-func-decls = range(0, num-ctors).map(lam(_): E.leb-u(closure-call-type-idx()) end)
      func-c = E.vec(rt-func-decls.append(lam-func-decls).append(ctor-func-decls).append([list: E.leb-u(main-type-idx())]))

      # ----- table + element segment: lambda funcidxs then ctor funcidxs -----
      num-slots = num-lams + num-ctors
      table-c = if num-slots == 0: empty
                else: E.vec([list: E.table-entry([list: 112], num-slots)]) end   # 112 = funcref
      lam-funcidxs = range(0, num-lams).map(lam(i): NUM-IMPORTS + (num-rt + i) end)
      ctor-funcidxs = range(0, num-ctors).map(lam(j): NUM-IMPORTS + ((num-rt + num-lams) + j) end)
      all-slots = lam-funcidxs.append(ctor-funcidxs)
      elem-c = if num-slots == 0: empty
               else: E.vec([list: E.elem-active-funcs(E.i32-const(0), all-slots)]) end

      # ----- globals: $variant_names (global 0 when there are variants), then one
      #       mutable anyref global per top-level binding (null-init; set in main) -----
      vn-global = if num-ctors == 0: empty
                  else: [list: E.global-entry(E.reft(T-FIELDS), 0, variant-names-init(ordered))] end
      tl-globals = range(0, num-tl).map(lam(_): E.global-entry(E.anyref, 1, E.i-ref-null(110)) end)
      # runtime globals ($link_id/$empty_id/$passed/$total) occupy the lowest indices.
      all-globals = R.rt-globals().append(vn-global.append(tl-globals))
      global-c = if is-empty(all-globals): empty else: E.vec(all-globals) end

      # ----- import section: host functions, module "host" (occupy the low funcidxs) -----
      import-c = E.vec(map2(lam(hi, k): E.import-func("host", hi.name, import-type-idx(k)) end,
                            R.host-imports, range(0, NUM-IMPORTS)))

      # ----- linear memory (scratch for string marshalling): 1..256 pages, exported -----
      mem-c = E.vec([list: E.mem-type(1, 256)])

      # ----- exports: main (func 0) + the memory (so the host reads rendered strings) -----
      export-c = E.vec([list: E.export-entry("main", 0, main-funcidx),
                              E.export-entry("memory", 2, 0)])

      # ----- code section -----
      code-c = E.vec(rt-code.append(lam-code).append(ctor-code).append([list: main-code]))

      E.wasm-module-of(type-c, import-c, func-c, table-c, mem-c, global-c, export-c, elem-c, code-c)
  end
end
