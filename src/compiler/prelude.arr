data List:
  | empty
  | link(first, rest)
sharing:
  method map(self, f): map(f, self) end,
  method filter(self, p): filter(p, self) end,
  method foldl(self, f, init): foldl(f, init, self) end,
  method foldr(self, f, init): foldr(f, init, self) end,
  method each(self, f): each(f, self) end,
  method length(self): length(self) end,
  method reverse(self): reverse(self) end,
  method append(self, other): append(self, other) end,
  method get(self, i): get(self, i) end,
  method member(self, x): member(self, x) end,
  method find(self, p): find(p, self) end,
  method last(self): last(self) end,
  method take(self, n): take(self, n) end,
  method drop(self, n): drop(self, n) end,
  method filter-map(self, f): filter-map(f, self) end,
  method partition(self, p): partition(p, self) end,
  method all(self, p): all(p, self) end,
  method any(self, p): any(p, self) end,
  method distinct(self): distinct(self) end,
  method sort(self): list-sort(self) end,
  method sort-by(self, lt, eq): list-sort-by(self, lt, eq) end,
  method join-str(self, sep): string-join(self, sep) end,
  method push(self, elt): link(elt, self) end,
  method map2(self, other, f): map2(f, self, other) end,
  method to-list(self): self end
end
# list sorting (insertion sort; CPS-safe: recursion + cases). sort-by takes a
# less-than comparator and an equality comparator (Pyret's signature); we order by lt.
fun list-insert-by(lt, x, l):
  cases(List) l:
    | empty => link(x, empty)
    | link(f, r) => if lt(x, f): link(x, l) else: link(f, list-insert-by(lt, x, r)) end
  end
end
fun list-sort-by(l, lt, eq):
  cases(List) l:
    | empty => empty
    | link(f, r) => list-insert-by(lt, f, list-sort-by(r, lt, eq))
  end
end
fun list-sort(l): list-sort-by(l, lam(a, b): a < b end, lam(a, b): a == b end) end

fun length(l):
  cases(List) l:
    | empty => 0
    | link(f, r) => 1 + length(r)
  end
end

fun map(fn, l):
  cases(List) l:
    | empty => empty
    | link(f, r) => link(fn(f), map(fn, r))
  end
end

fun filter(pred, l):
  cases(List) l:
    | empty => empty
    | link(f, r) =>
      if pred(f): link(f, filter(pred, r))
      else: filter(pred, r) end
  end
end

fun foldl(fn, acc, l):
  cases(List) l:
    | empty => acc
    | link(f, r) => foldl(fn, fn(acc, f), r)
  end
end

fun foldr(fn, acc, l):
  cases(List) l:
    | empty => acc
    | link(f, r) => fn(foldr(fn, acc, r), f)
  end
end

fun sum(l):
  cases(List) l:
    | empty => 0
    | link(f, r) => f + sum(r)
  end
end

fun append(a, b):
  cases(List) a:
    | empty => b
    | link(f, r) => link(f, append(r, b))
  end
end

fun reverse(l):
  cases(List) l:
    | empty => empty
    | link(f, r) => append(reverse(r), link(f, empty))
  end
end

fun member(l, x):
  cases(List) l:
    | empty => false
    | link(f, r) => if f == x: true else: member(r, x) end
  end
end

data Option:
  | none
  | some(value)
sharing:
  method or-else(self, v): cases(Option) self: | none => v | some(x) => x end end,
  method and-then(self, f): cases(Option) self: | none => none | some(x) => some(f(x)) end end
end

# ---- boolean / numeric builtins (pure Pyret) ----
fun not(b): if b: false else: true end end
fun identity(x): x end
fun string-repeat(s, n): if n <= 0: "" else: s + string-repeat(s, n - 1) end end
fun is-nothing(x): x == nothing end
fun all(pred, l): cases(List) l: | empty => true | link(f, r) => pred(f) and all(pred, r) end end
fun any(pred, l): cases(List) l: | empty => false | link(f, r) => pred(f) or any(pred, r) end end

# ---- string library (built on string-from-code-point + string-to-code-points) ----
fun list-take(l, n): if n <= 0: empty else: cases(List) l: | empty => empty | link(f, r) => link(f, list-take(r, n - 1)) end end end
fun list-drop(l, n): if n <= 0: l else: cases(List) l: | empty => empty | link(f, r) => list-drop(r, n - 1) end end end
fun cps-prefix(pre, l): cases(List) pre: | empty => true | link(pf, pr) => cases(List) l: | empty => false | link(lf, lr) => (pf == lf) and cps-prefix(pr, lr) end end end
fun cps-contains(scp, sub): if cps-prefix(sub, scp): true else: cases(List) scp: | empty => false | link(f, r) => cps-contains(r, sub) end end end
fun cps-index(scp, sub, i): if cps-prefix(sub, scp): i else: cases(List) scp: | empty => 0 - 1 | link(f, r) => cps-index(r, sub, i + 1) end end end
fun cps-tonum(cp, acc, seen): cases(List) cp: | empty => if seen: some(acc) else: none end | link(f, r) => if (f >= 48) and (f <= 57): cps-tonum(r, (acc * 10) + (f - 48), true) else: none end end end
fun string-from-code-points(cps): foldl(lam(acc, c): acc + string-from-code-point(c) end, "", cps) end
fun string-append(a, b): a + b end
fun string-substring(s, a, b): string-from-code-points(list-take(list-drop(string-to-code-points(s), a), b - a)) end
fun string-char-at(s, i): string-from-code-points(list-take(list-drop(string-to-code-points(s), i), 1)) end
fun string-explode(s): map(lam(c): string-from-code-point(c) end, string-to-code-points(s)) end
fun string-to-lower(s): string-from-code-points(map(lam(c): if (c >= 65) and (c <= 90): c + 32 else: c end end, string-to-code-points(s))) end
fun string-to-upper(s): string-from-code-points(map(lam(c): if (c >= 97) and (c <= 122): c - 32 else: c end end, string-to-code-points(s))) end
fun string-tolower(s): string-to-lower(s) end
fun string-toupper(s): string-to-upper(s) end
fun string-contains(s, sub): cps-contains(string-to-code-points(s), string-to-code-points(sub)) end
fun string-index-of(s, sub): cps-index(string-to-code-points(s), string-to-code-points(sub), 0) end
fun string-to-number(s): cps-tonum(string-to-code-points(s), 0, false) end
fun string-tonumber(s): string-to-number(s) end
fun num-to-string(n): tostring(n) end
fun num-tostring(n): tostring(n) end
fun num-abs(n): if n < 0: 0 - n else: n end end
fun num-min(a, b): if a < b: a else: b end end
fun num-max(a, b): if a > b: a else: b end end
fun num-sqr(n): n * n end
fun num-negate(n): 0 - n end

# ---- more list builtins (pure Pyret) ----
fun range(a, b):
  if a >= b: empty else: link(a, range(a + 1, b)) end
end

fun repeat(n, e):
  if n <= 0: empty else: link(e, repeat(n - 1, e)) end
end

fun each(f, l):
  cases(List) l:
    | empty => nothing
    | link(fst, r) => block:
        f(fst)
        each(f, r)
      end
  end
end

fun map2(f, a, b):
  cases(List) a:
    | empty => empty
    | link(fa, ra) =>
      cases(List) b:
        | empty => empty
        | link(fb, rb) => link(f(fa, fb), map2(f, ra, rb))
      end
  end
end

# indexed-map family (the _n functions) — f receives a running index.
fun map_n(f, n, lst):
  cases(List) lst: | empty => empty | link(fst, rst) => link(f(n, fst), map_n(f, n + 1, rst)) end
end
fun map2_n(f, n, l1, l2):
  cases(List) l1: | empty => empty
    | link(a, ra) => cases(List) l2: | empty => empty | link(b, rb) => link(f(n, a, b), map2_n(f, n + 1, ra, rb)) end end
end
fun each_n(f, num, lst):
  cases(List) lst: | empty => nothing | link(fst, rst) => block: f(num, fst) each_n(f, num + 1, rst) end end
end
fun fold_n(f, num, base, lst):
  cases(List) lst: | empty => base | link(fst, rst) => fold_n(f, num + 1, f(num, base, fst), rst) end
end

fun find(f, l):
  cases(List) l:
    | empty => false
    | link(fst, r) => if f(fst): fst else: find(f, r) end
  end
end

fun get(l, i):
  cases(List) l:
    | empty => raise("get: index out of range")
    | link(fst, r) => if i == 0: fst else: get(r, i - 1) end
  end
end

fun last(l):
  cases(List) l:
    | empty => raise("last: empty list")
    | link(fst, r) =>
      cases(List) r:
        | empty => fst
        | link(g, rr) => last(r)
      end
  end
end

fun fold(f, acc, l): foldl(f, acc, l) end

# ---- IMAGE LIBRARY (code.pyret.org-style) ----
# Images are a lazy SCENE GRAPH: each constructor is just a data variant that
# records its arguments. Nothing is rasterized in WASM — the IDE walks this graph
# and draws it to a <canvas> (the canvas is the minimal JS glue WASM can't do).
# 'mode' is a string "solid"/"outline"; 'color' is a CSS color name string.
data Image:
  | circle(radius, mode, color)
  | square(side, mode, color)
  | rectangle(width, height, mode, color)
  | ellipse(ewidth, eheight, mode, color)
  | triangle(side, mode, color)
  | text(content, size, color)
  | line(linex, liney, color)
  | star(starradius, mode, color)
  | overlay(top, bot)
  | overlay-xy(top, dx, dy, bot)
  | beside(imgleft, imgright)
  | above(imgup, imgdown)
  | place-image(placed, px, py, scene)
  | empty-scene(scenew, sceneh)
  | scale(factor, simg)
  | rotate(degrees, rimg)
  | frame(fimg)
  | image-url(url)
end

fun image-width(img):
  cases(Image) img:
    | circle(radius, mode, color) => 2 * radius
    | square(side, mode, color) => side
    | rectangle(width, height, mode, color) => width
    | ellipse(ewidth, eheight, mode, color) => ewidth
    | triangle(side, mode, color) => side
    | text(content, size, color) => string-length(content) * size
    | line(linex, liney, color) => num-abs(linex)
    | star(starradius, mode, color) => 2 * starradius
    | overlay(top, bot) => num-max(image-width(top), image-width(bot))
    | overlay-xy(top, dx, dy, bot) => num-max(image-width(top), image-width(bot))
    | beside(imgleft, imgright) => image-width(imgleft) + image-width(imgright)
    | above(imgup, imgdown) => num-max(image-width(imgup), image-width(imgdown))
    | place-image(placed, px, py, scene) => image-width(scene)
    | empty-scene(scenew, sceneh) => scenew
    | scale(factor, simg) => factor * image-width(simg)
    | rotate(degrees, rimg) => image-width(rimg)
    | frame(fimg) => image-width(fimg)
    | image-url(url) => 100
  end
end

fun image-height(img):
  cases(Image) img:
    | circle(radius, mode, color) => 2 * radius
    | square(side, mode, color) => side
    | rectangle(width, height, mode, color) => height
    | ellipse(ewidth, eheight, mode, color) => eheight
    | triangle(side, mode, color) => side
    | text(content, size, color) => size
    | line(linex, liney, color) => num-abs(liney)
    | star(starradius, mode, color) => 2 * starradius
    | overlay(top, bot) => num-max(image-height(top), image-height(bot))
    | overlay-xy(top, dx, dy, bot) => num-max(image-height(top), image-height(bot))
    | beside(imgleft, imgright) => num-max(image-height(imgleft), image-height(imgright))
    | above(imgup, imgdown) => image-height(imgup) + image-height(imgdown)
    | place-image(placed, px, py, scene) => image-height(scene)
    | empty-scene(scenew, sceneh) => sceneh
    | scale(factor, simg) => factor * image-height(simg)
    | rotate(degrees, rimg) => image-height(rimg)
    | frame(fimg) => image-height(fimg)
    | image-url(url) => 100
  end
end

# ---- raw arrays (primitive: a $Fields cell; get/length/set are intrinsics) ----
fun raw-array-to-list(arr):
  fun ra-loop(i, n): if i >= n: empty else: link(raw-array-get(arr, i), ra-loop(i + 1, n)) end end
  ra-loop(0, raw-array-length(arr))
end
fun raw-array-each(f, arr):
  fun ra-eloop(i, n): if i >= n: nothing else: block: f(raw-array-get(arr, i)) ra-eloop(i + 1, n) end end end
  ra-eloop(0, raw-array-length(arr))
end
fun raw-array-fold(f, init, arr, start):
  fun ra-floop(i, n, acc): if i >= n: acc else: ra-floop(i + 1, n, f(acc, raw-array-get(arr, i), i + start)) end end
  ra-floop(0, raw-array-length(arr), init)
end
fun raw-array-from-list(l):
  arr = raw-array-of(0, length(l))
  fun ra-fill(i, xs): cases(List) xs: | empty => arr | link(f, r) => block: raw-array-set(arr, i, f) ra-fill(i + 1, r) end end end
  ra-fill(0, l)
end
fun raw-array-map(f, arr):
  n = raw-array-length(arr)
  res = raw-array-of(0, n)
  fun ra-mloop(i): if i >= n: res else: block: raw-array-set(res, i, f(raw-array-get(arr, i))) ra-mloop(i + 1) end end end
  ra-mloop(0)
end

# ---- string-dict (immutable assoc; latest write wins). Built from a key/value
# data type (not tuples) so the stoppable CPS transform handles the prelude. ----
data KV: | kv(kvk, kvv) end
fun sd-get(entries, k):
  cases(List) entries:
    | empty => none
    | link(p, r) => cases(KV) p: | kv(pk, pv) => if pk == k: some(pv) else: sd-get(r, k) end end
  end
end
fun sd-del(entries, k):
  cases(List) entries:
    | empty => empty
    | link(p, r) => cases(KV) p: | kv(pk, pv) => if pk == k: sd-del(r, k) else: link(p, sd-del(r, k)) end end
  end
end
data StringDict:
  | s-str-dict(entries)
sharing:
  method get(self, k): sd-get(self.entries, k) end,
  method get-value(self, k):
    cases(Option) sd-get(self.entries, k): | some(v) => v | none => raise("Key not found: " + k) end
  end,
  method set(self, k, v): s-str-dict(link(kv(k, v), sd-del(self.entries, k))) end,
  method has-key(self, k): cases(Option) sd-get(self.entries, k): | some(v) => true | none => false end end,
  method remove(self, k): s-str-dict(sd-del(self.entries, k)) end,
  method keys-list(self): map(lam(p): cases(KV) p: | kv(pk, pv) => pk end end, self.entries) end,
  method count(self): length(self.entries) end,
  method to-list(self): self.entries end,
  method keys(self): set-from-list(self.keys-list()) end,
  method fold-keys(self, f, init): foldl(f, init, self.keys-list()) end,
  method each-key(self, f): each(f, self.keys-list()) end,
  method map-keys(self, f): map(f, self.keys-list()) end,
  method merge(self, other): foldl(lam(acc, k): acc.set(k, other.get-value(k)) end, self, other.keys-list()) end
end
fun sd-from-raw(arr):
  fun sd-loop(i, n):
    if i >= n: empty else: link(kv(raw-array-get(arr, i), raw-array-get(arr, i + 1)), sd-loop(i + 2, n)) end
  end
  s-str-dict(sd-loop(0, raw-array-length(arr)))
end

# ---- sets (immutable, dedup) ----
fun set-mem(l, x): cases(List) l: | empty => false | link(f, r) => (f == x) or set-mem(r, x) end end
data PSet:
  | p-set(elems)
sharing:
  method member(self, x): set-mem(self.elems, x) end,
  method add(self, x): if set-mem(self.elems, x): self else: p-set(link(x, self.elems)) end end,
  method remove(self, x): p-set(filter(lam(e): not(e == x) end, self.elems)) end,
  method to-list(self): self.elems end,
  method size(self): length(self.elems) end,
  method union(self, other): foldl(lam(acc, e): acc.add(e) end, self, other.to-list()) end,
  method intersect(self, other): p-set(filter(lam(e): other.member(e) end, self.elems)) end,
  method difference(self, other): p-set(filter(lam(e): not(other.member(e)) end, self.elems)) end,
  method fold(self, f, init): foldl(f, init, self.elems) end
end
fun set-from-raw(arr): foldl(lam(acc, e): acc.add(e) end, p-set(empty), raw-array-to-list(arr)) end
# Bare-identifier empty-set values used across the front-end (list-set/tree-set are
# the same representation: an immutable dedup set).
empty-set = p-set(empty)
empty-list-set = p-set(empty)
empty-tree-set = p-set(empty)

fun make-string-dict(): s-str-dict(empty) end

# ---- mutable string-dict: a shared 1-cell raw-array holding the entries list, so
# set-now/remove-now mutations are visible through every reference. ----
data MutDict:
  | m-dict(cell)
sharing:
  method get-now(self, k): sd-get(raw-array-get(self.cell, 0), k) end,
  method get-value-now(self, k):
    cases(Option) sd-get(raw-array-get(self.cell, 0), k):
      | some(v) => v | none => raise("Key not found: " + k) end end,
  method set-now(self, k, v) block:
    raw-array-set(self.cell, 0, link(kv(k, v), sd-del(raw-array-get(self.cell, 0), k)))
    self end,
  method has-key-now(self, k):
    cases(Option) sd-get(raw-array-get(self.cell, 0), k): | some(v) => true | none => false end end,
  method remove-now(self, k) block:
    raw-array-set(self.cell, 0, sd-del(raw-array-get(self.cell, 0), k))
    self end,
  method keys-list-now(self): map(lam(p): cases(KV) p: | kv(pk, pv) => pk end end, raw-array-get(self.cell, 0)) end,
  method keys-now(self): set-from-list(self.keys-list-now()) end,
  method count-now(self): length(raw-array-get(self.cell, 0)) end,
  method to-list-now(self): raw-array-get(self.cell, 0) end,
  method each-key-now(self, f): each(f, self.keys-list-now()) end,
  method map-keys-now(self, f): map(f, self.keys-list-now()) end,
  method freeze(self): s-str-dict(raw-array-get(self.cell, 0)) end,
  method merge-now(self, other) block:
    each(lam(k): self.set-now(k, other.get-value-now(k)) end, other.keys-list-now())
    self end
end
fun make-mutable-string-dict(): m-dict(raw-array-of(empty, 1)) end
fun mut-sd-from-raw(arr):
  d = make-mutable-string-dict()
  fun loop(i, n):
    if i >= n: d
    else: block:
      d.set-now(raw-array-get(arr, i), raw-array-get(arr, i + 1))
      loop(i + 2, n)
    end end
  end
  loop(0, raw-array-length(arr))
end
fun set-from-list(l): foldl(lam(acc, e): acc.add(e) end, p-set(empty), l) end

# string-dict module functions usable on either dict kind; drive Pyret for-loops:
#   for fold-keys(acc from base, k from d): ... end   /   for each-key-now(k from d): ... end
fun dict-keys-list(d): if is-m-dict(d): d.keys-list-now() else: d.keys-list() end end
fun fold-keys(f, init, d): foldl(f, init, dict-keys-list(d)) end
fun each-key(f, d): each(f, dict-keys-list(d)) end
fun each-key-now(f, d): each(f, dict-keys-list(d)) end
fun map-keys(f, d): map(f, dict-keys-list(d)) end
fun map-keys-now(f, d): map(f, dict-keys-list(d)) end
fun fold-keys-now(f, init, d): foldl(f, init, dict-keys-list(d)) end

# === raw-array builders / list / string helpers (used by the real front-end) ===
fun raw-array-build(f, n):
  arr = raw-array-of(0, n)
  fun rb-loop(i): if i >= n: arr else: block: raw-array-set(arr, i, f(i)) rb-loop(i + 1) end end end
  rb-loop(0)
end
fun raw-array-duplicate(arr):
  n = raw-array-length(arr)
  res = raw-array-of(0, n)
  fun rd-loop(i): if i >= n: res else: block: raw-array-set(res, i, raw-array-get(arr, i)) rd-loop(i + 1) end end end
  rd-loop(0)
end
fun take(l, n): list-take(l, n) end
fun drop(l, n): list-drop(l, n) end
fun filter-map(f, l):
  cases(List) l:
    | empty => empty
    | link(x, r) => cases(Option) f(x): | some(v) => link(v, filter-map(f, r)) | none => filter-map(f, r) end
  end
end
fun distinct(l):
  cases(List) l:
    | empty => empty
    | link(x, r) => if member(r, x): distinct(r) else: link(x, distinct(r)) end
  end
end
data PartitionR: | partition-r(is-true, is-false) end
fun partition(pred, l):
  cases(List) l:
    | empty => partition-r(empty, empty)
    | link(x, r) =>
      sub = partition(pred, r)
      if pred(x): partition-r(link(x, sub.is-true), sub.is-false)
      else: partition-r(sub.is-true, link(x, sub.is-false)) end
  end
end
fun list-to-set(l): set-from-list(l) end
fun list-to-tree-set(l): set-from-list(l) end
fun string-join(l, sep):
  cases(List) l:
    | empty => ""
    | link(f, r) => cases(List) r: | empty => f | link(a, b) => f + sep + string-join(r, sep) end
  end
end
fun string-split-all(s, sep):
  if string-length(sep) == 0: [list: s]
  else:
    idx = string-index-of(s, sep)
    if idx < 0: [list: s]
    else:
      before = string-substring(s, 0, idx)
      after = string-substring(s, idx + string-length(sep), string-length(s))
      link(before, string-split-all(after, sep))
    end
  end
end
fun string-split(s, sep):
  idx = string-index-of(s, sep)
  if idx < 0: [list: s]
  else: [list: string-substring(s, 0, idx), string-substring(s, idx + string-length(sep), string-length(s))]
  end
end
fun string-replace(s, find, repl): string-join(string-split-all(s, find), repl) end
