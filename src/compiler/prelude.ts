// A small standard prelude, written in Pyret itself and compiled by our own
// backend (dogfooding data/cases/closures/recursion). Prepended to user
// programs. This is the seed of the eventual Pyret-sourced stdlib.
//
// `[list: 1, 2, 3]` construct syntax is desugared by the compiler into
// link/empty using the List type defined here.

export const PRELUDE_SRC = `
data List:
  | empty
  | link(first, rest)
end

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
end

# ---- boolean / numeric builtins (pure Pyret) ----
fun not(b): if b: false else: true end end
fun identity(x): x end
fun string-repeat(s, n): if n <= 0: "" else: s + string-repeat(s, n - 1) end end
fun is-nothing(x): x == nothing end
fun all(pred, l): cases(List) l: | empty => true | link(f, r) => pred(f) and all(pred, r) end end
fun any(pred, l): cases(List) l: | empty => false | link(f, r) => pred(f) or any(pred, r) end end
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
`;
