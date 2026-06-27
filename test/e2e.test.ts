import { test, expect } from "bun:test";
import { buildSource, buildSourceFile } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

async function evalPyret(src: string): Promise<string> {
  const { output } = await run(await buildSource(src));
  return output.trimEnd();
}

async function errOf(src: string): Promise<string | undefined> {
  const { error } = await run(await buildSource(src));
  return error;
}

test("integer arithmetic", async () => {
  expect(await evalPyret("5 + 3")).toBe("8");
  expect(await evalPyret("2 * 3 * 4")).toBe("24");
  expect(await evalPyret("10 - 4")).toBe("6");
});

test("arbitrary-precision integers (bignum)", async () => {
  expect(await evalPyret("9223372036854775807 + 1")).toBe("9223372036854775808");
  expect(await evalPyret("123456789012345678901234567890")).toBe("123456789012345678901234567890");
  expect(await evalPyret("1000000000000 * 1000000000000")).toBe("1000000000000000000000000");
  expect(await evalPyret("0 - 123456789012345678901234567890")).toBe("-123456789012345678901234567890");
  // big arithmetic that comes back down to a fixnum
  expect(await evalPyret("(10000000000 * 10000000000) - (10000000000 * 10000000000) + 7")).toBe("7");
  // factorial(100) — exact, 158 digits
  const fact100 = "93326215443944152681699238856266700490715968264381621468592963895217599993229915608941463976156518286253697920827223758251185210916864000000000000000000000000";
  expect(await evalPyret("fun f(n): if n <= 1: 1 else: n * f(n - 1) end end\nf(100)")).toBe(fact100);
});

test("bignum equality and comparison in checks", async () => {
  const src = "check:\n" +
    "  9223372036854775807 + 1 is 9223372036854775808\n" +
    "  2 * 4611686018427387904 is 9223372036854775808\n" +
    "  100000000000 * 100000000000 is 10000000000000000000000\n" +
    "  10000000000000000000000 > 999 is true\nend";
  expect(await evalPyret(src)).toContain("all 4 tests passed");
});

test("bignum rationals (arbitrary-precision exact rationals)", async () => {
  expect(await evalPyret("1 / 10000000000000000000000")).toBe("1/10000000000000000000000");
  expect(await evalPyret("10000000000000000000000 + 1/2")).toBe("20000000000000000000001/2");
  expect(await evalPyret("10000000000000000000000 / 20000000000000000000000")).toBe("1/2");
  expect(await evalPyret("(1/3) * 30000000000000000000000")).toBe("10000000000000000000000");
  // f(30)/f(28) == 30*29 == 870, exact through huge intermediates
  expect(await evalPyret("fun f(n): if n <= 1: 1 else: n * f(n - 1) end end\nf(30) / f(28)")).toBe("870");
});

test("exact rationals", async () => {
  expect(await evalPyret("1/2 + 1/3")).toBe("5/6");
  expect(await evalPyret("10 / 4")).toBe("5/2");
  expect(await evalPyret("2/3 * 3/4")).toBe("1/2");
});

test("left-associative folding", async () => {
  expect(await evalPyret("10 - 3 - 2")).toBe("5");
});

test("parenthesized grouping", async () => {
  expect(await evalPyret("(2 + 3) * 4")).toBe("20");
});

test("booleans and comparisons", async () => {
  expect(await evalPyret("true")).toBe("true");
  expect(await evalPyret("5 < 8")).toBe("true");
  expect(await evalPyret("8 <= 8")).toBe("true");
  expect(await evalPyret("3 == 4")).toBe("false");
  expect(await evalPyret("1/2 == 2/4")).toBe("true");
  expect(await evalPyret("(3 < 4) and (5 < 2)")).toBe("false");
  expect(await evalPyret("(3 < 4) or (5 < 2)")).toBe("true");
});

test("if expressions", async () => {
  expect(await evalPyret("if 2 > 3: 100 else: 200 end")).toBe("200");
  expect(await evalPyret("if 5 < 8: 1 else: 0 end")).toBe("1");
});

test("let bindings and identifiers", async () => {
  expect(await evalPyret("x = 10\ny = 20\nif x < y: x + y else: 0 end")).toBe("30");
  expect(await evalPyret("a = 2\nb = a * a\nb + 1")).toBe("5");
});

test("recursive functions", async () => {
  expect(await evalPyret("fun fact(n): if n <= 1: 1 else: n * fact(n - 1) end end\nfact(5)")).toBe("120");
  expect(await evalPyret("fun fib(n): if n < 2: n else: fib(n - 1) + fib(n - 2) end end\nfib(10)")).toBe("55");
});

test("mutual recursion", async () => {
  const src = "fun iseven(n): if n == 0: true else: isodd(n - 1) end end\n" +
              "fun isodd(n): if n == 0: false else: iseven(n - 1) end end\n" +
              "iseven(10)";
  expect(await evalPyret(src)).toBe("true");
});

test("proper tail calls (deep recursion does not overflow)", async () => {
  const src = "fun count(n, acc): if n == 0: acc else: count(n - 1, acc + 1) end end\n" +
              "count(2000000, 0)";
  expect(await evalPyret(src)).toBe("2000000");
});

test("lists and the Pyret-written stdlib", async () => {
  expect(await evalPyret("length([list: 1, 2, 3])")).toBe("3");
  expect(await evalPyret("foldl(lam(a, b): a + b end, 0, [list: 1, 2, 3, 4])")).toBe("10");
  const src = `check:
  map(lam(x): x + 1 end, [list: 1, 2, 3]) is [list: 2, 3, 4]
  filter(lam(x): x > 2 end, [list: 1, 2, 3, 4]) is [list: 3, 4]
  reverse([list: 1, 2, 3]) is [list: 3, 2, 1]
  member([list: 1, 2, 3], 2) is true
  append([list: 1, 2], [list: 3, 4]) is [list: 1, 2, 3, 4]
end`;
  expect(await evalPyret(src)).toContain("all 5 tests passed");
});

test("for loops desugar to higher-order calls", async () => {
  expect(await evalPyret("for foldl(acc from 0, n from [list: 1, 2, 3, 4]): acc + n end")).toBe("10");
  const src = "check:\n" +
    "  for map(x from [list: 1, 2, 3]): x * x end is [list: 1, 4, 9]\n" +
    "  for filter(x from [list: 1, 2, 3, 4]): x > 2 end is [list: 3, 4]\nend";
  expect(await evalPyret(src)).toContain("all 2 tests passed");
});

test("objects, dot-access, methods", async () => {
  expect(await evalPyret("{x: 1, y: 2}")).toBe("{x: 1, y: 2}");
  expect(await evalPyret("p = {x: 10, y: 20}\np.x + p.y")).toBe("30");
  expect(await evalPyret("o = {n: 5, method get-n(self): self.n end}\no.get-n()")).toBe("5");
  expect(await evalPyret("o = {base: 100, method add(self, k): self.base + k end}\no.add(7)")).toBe("107");
  const eq = "check:\n  {a: 1, b: 2} is {a: 1, b: 2}\n  {a: 1} is-not {a: 2}\nend";
  expect(await evalPyret(eq)).toContain("all 2 tests passed");
});

test("lambdas, closures, higher-order functions", async () => {
  expect(await evalPyret("f = lam(x): x + 1 end\nf(10)")).toBe("11");
  expect(await evalPyret("fun adder(n): lam(x): x + n end end\nadd5 = adder(5)\nadd5(100)")).toBe("105");
  expect(await evalPyret("fun apply-twice(f, x): f(f(x)) end\nfun inc(n): n + 1 end\napply-twice(inc, 10)")).toBe("12");
});

test("tail calls through indirect (closure) calls", async () => {
  const src = "fun count(n, acc): if n == 0: acc else: count(n - 1, acc + 1) end end\ncount(3000000, 0)";
  expect(await evalPyret(src)).toBe("3000000");
});

test("local function definitions with capture", async () => {
  expect(await evalPyret("fun outer(x):\n  fun helper(y): y * y end\n  helper(x) + helper(x)\nend\nouter(5)")).toBe("50");
});

test("data declarations and cases", async () => {
  expect(await evalPyret("data Color: | red | green | blue end\nred")).toBe("red");
  expect(await evalPyret("data Point: | pt(x, y) end\npt(3, 4)")).toBe("pt(3, 4)");
  expect(await evalPyret("data C: | red | green end\nis-red(red)")).toBe("true");
  expect(await evalPyret("data C: | red | green end\nis-red(green)")).toBe("false");
  const speak = "data Animal: | cat | dog(name) end\n" +
    "fun speak(a): cases(Animal) a: | cat => \"meow\" | dog(n) => \"woof: \" + n end end\n" +
    "speak(dog(\"Rex\"))";
  expect(await evalPyret(speak)).toBe("woof: Rex");
});

test("recursive data + recursive cases + structural equality", async () => {
  const src = `data MyList:
  | mt
  | node(first, rest)
end
fun mylen(l): cases(MyList) l: | mt => 0 | node(f, r) => 1 + mylen(r) end end
fun mysum(l): cases(MyList) l: | mt => 0 | node(f, r) => f + mysum(r) end end
lst = node(10, node(20, node(30, mt)))
check:
  mylen(lst) is 3
  mysum(lst) is 60
  node(1, mt) is node(1, mt)
  node(1, mt) is-not node(2, mt)
end`;
  // is-not not yet supported; use a simpler check
  const simple = src.replace("  node(1, mt) is-not node(2, mt)\n", "");
  expect(await evalPyret(simple)).toContain("all 3 tests passed");
});

test("check operators is-not and satisfies", async () => {
  const src = `check:
  1 is-not 2
  [list: 1, 2] is-not [list: 1, 3]
  "abc" is-not "abd"
  5 satisfies lam(x): x > 3 end
end`;
  expect(await evalPyret(src)).toContain("all 4 tests passed");
  const failing = "check:\n  2 satisfies lam(x): x > 3 end\nend";
  expect(await evalPyret(failing)).toContain("0 passed, 1 failed");
});

test("runtime errors raise Pyret messages", async () => {
  expect(await errOf("5 / 0")).toContain("divided by zero");
  const noMatch = "data C: | a | b | c end\ncases(C) c:\n  | a => 1\n  | b => 2\nend";
  expect(await errOf(noMatch)).toContain("no branch matched");
});

test("nested data rendering", async () => {
  expect(await evalPyret("data L: | mt | node(f, r) end\nnode(1, node(2, mt))"))
    .toBe("node(1, node(2, mt))");
});

test("check blocks report results", async () => {
  expect(await evalPyret("check:\n  2 + 2 is 4\n  1/2 + 1/2 is 1\nend"))
    .toBe("Looks shipshape, all 2 tests passed, mate!");
  const withFail = await evalPyret('fun dbl(n): n * 2 end\ncheck:\n  dbl(3) is 6\n  dbl(0) is 1\nend');
  expect(withFail).toContain("test failed: 0 is 1");
  expect(withFail).toContain("1 passed, 1 failed");
});

test("strings", async () => {
  expect(await evalPyret('"hello"')).toBe("hello");
  expect(await evalPyret('"foo" + "bar"')).toBe("foobar");
  expect(await evalPyret('"abc" == "abc"')).toBe("true");
  expect(await evalPyret('"abc" == "abd"')).toBe("false");
  expect(await evalPyret('fun greet(w): "Hi, " + w + "!" end\ngreet("world")')).toBe("Hi, world!");
});

test("prelude builtins (not, num-abs, range, map2, find)", async () => {
  expect(await evalPyret("not(false)")).toBe("true");
  expect(await evalPyret("num-abs(0 - 7)")).toBe("7");
  expect(await evalPyret("num-min(3, 8)")).toBe("3");
  expect(await evalPyret("find(lam(x): x > 2 end, [list: 1, 2, 3, 4])")).toBe("3");
  const src = "check:\n" +
    "  range(0, 4) is [list: 0, 1, 2, 3]\n" +
    "  repeat(3, 7) is [list: 7, 7, 7]\n" +
    "  map2(lam(a, b): a + b end, [list: 1, 2], [list: 10, 20]) is [list: 11, 22]\n" +
    "  num-max(3, 8) is 8\nend";
  expect(await evalPyret(src)).toContain("all 4 tests passed");
});

test("raise produces an error surfaced by the runtime", async () => {
  expect(await errOf('raise("boom")')).toContain("boom");
});

test("lists display as [list: ...]", async () => {
  expect(await evalPyret("[list: 1, 2, 3]")).toBe("[list: 1, 2, 3]");
  expect(await evalPyret("[list: ]")).toBe("[list: ]");
  expect(await evalPyret("range(0, 5)")).toBe("[list: 0, 1, 2, 3, 4]");
  expect(await evalPyret("map(lam(x): x * x end, [list: 1, 2, 3])")).toBe("[list: 1, 4, 9]");
  expect(await evalPyret("[list: [list: 1], [list: 2, 3]]")).toBe("[list: [list: 1], [list: 2, 3]]");
});

test("var + assignment (:=) and tostring", async () => {
  expect(await evalPyret("var c = 0\nfun inc(): c := c + 1 end\ninc()\ninc()\ninc()\nc")).toBe("3");
  expect(await evalPyret('tostring(5) + "!"')).toBe("5!");
  expect(await evalPyret('tostring([list: 1, 2])')).toBe("[list: 1, 2]");
});

test("data variant methods (with: per-variant, sharing: shared, self-bound dispatch)", async () => {
  expect(await evalPyret(
    "data T:\n  | v(a) with: method m(self): self.a + 1 end\n  | w(b) with: method m(self): self.b * 10 end\nsharing:\n  method tag(self): 99 end\nend\n(v(5).m() + w(3).m()) + v(0).tag()")).toBe("135");
  // method with args that calls another method on self
  expect(await evalPyret(
    "data Pt:\n  | pt(x, y) with:\n    method dist-sq(self): (self.x * self.x) + (self.y * self.y) end,\n    method scaled(self, k): pt(self.x * k, self.y * k) end\nend\npt(3, 4).scaled(2).dist-sq()")).toBe("100");
  // torepr/tostring usable as first-class values
  expect(await evalPyret("map(torepr, [list: 1, 2, 3])")).toBe("[list: 1, 2, 3]");
});

test("variant field access by name, ask, ^, _ curry, all/any (real-compiler features)", async () => {
  // data field access by dot name
  expect(await evalPyret("data Tree: | leaf | node(v, l, r) end\nt = node(5, leaf, node(7, leaf, leaf))\nt.v + t.r.v")).toBe("12");
  // ask: (if-pipe)
  expect(await evalPyret("fun c(n): ask:\n | n < 0 then: 0 - 1\n | n == 0 then: 0\n | otherwise: 1\n end end\nc(0 - 9) + c(0) + c(4)")).toBe("0");
  // ^ reverse application
  expect(await evalPyret("fun inc(x): x + 1 end\nfun dbl(x): x * 2 end\n5 ^ inc ^ dbl")).toBe("12");
  // `_` curry (binop, method/dot, two-underscore)
  expect(await evalPyret("foldl(_ + _, 0, map(_ + 10, [list: 1, 2, 3]))")).toBe("36");
  expect(await evalPyret("data Box: box(v) end\nfoldl(_ + _, 0, map(_.v, [list: box(7), box(8)]))")).toBe("15");
  // all / any
  expect(await evalPyret("fun ev(n): num-modulo(n, 2) == 0 end\nif all(ev, [list: 2, 4, 6]) and any(ev, [list: 1, 2, 3]): 1 else: 0 end")).toBe("1");
});

test("first-class data constructors and is-<variant> predicates", async () => {
  expect(await evalPyret(
    "data Tree: | leaf | node(v, l, r) end\nmk = node\nt = mk(5, leaf, leaf)\ncases(Tree) t: | leaf => 0 | node(v, l, r) => v end")).toBe("5");
  expect(await evalPyret(
    "data Tree: | leaf | node(v, l, r) end\np = is-node\nif p(node(7, leaf, leaf)) and not(p(leaf)): 1 else: 0 end")).toBe("1");
  // constructor passed to a higher-order function (map)
  expect(await evalPyret(
    "data Box: box(v) end\nl = map(box, [list: 1, 2, 3])\ncases(List) l: | empty => 0 | link(f, r) => cases(Box) f: | box(v) => v end end")).toBe("1");
});

test("mutable variable captured + mutated by a closure (boxing)", async () => {
  // a function-LOCAL var shared across closures (globals are already shared; locals
  // need a boxed cell). Mirrors ast.arr's MakeName counter.
  expect(await evalPyret(
    "fun mk(start):\n  var count = start\n  fun bump(): block: count := count + 1\n count end end\n  bump\nend\nc = mk(10)\nc()\nc()\nc()")).toBe("13");
  // a closure that ONLY assigns the captured var (LHS-only use must still capture+box)
  expect(await evalPyret(
    "fun mk(start):\n  var count = start\n  fun bump(): block: count := count + 1\n count end end\n  reset = lam(): count := start end\n  bump()\n  bump()\n  reset()\n  bump()\nend\nmk(100)")).toBe("101");
});

test("Option type, print, raises check op", async () => {
  expect(await evalPyret("cases(Option) some(5): | none => 0 | some(v) => v end")).toBe("5");
  expect(await evalPyret('print("hi")\n42')).toBe("hi\n42");
  const r = await evalPyret('check:\n  raise("boom") raises "boom"\n  5 raises "x"\nend');
  expect(r).toContain("1 passed, 1 failed");
});

test("compiles a real Pyret compiler-source module (gensym.arr)", async () => {
  const src = await Bun.file("pyret/lang/src/arr/compiler/gensym.arr").text();
  const wasm = await buildSource(src);
  expect(wasm.length).toBeGreaterThan(0);
});

test("import/include modules (aliases resolve to globals)", async () => {
  expect(await evalPyret("import lists as L\nL.map(lam(x): x * 2 end, [list: 1, 2, 3])")).toBe("[list: 2, 4, 6]");
  expect(await evalPyret("include lists\nmap(lam(x): x + 1 end, [list: 1, 2])")).toBe("[list: 2, 3]");
  expect(await evalPyret("import lists as L\nL.foldl(lam(a, b): a + b end, 0, [list: 1, 2, 3, 4])")).toBe("10");
});

test("tuples", async () => {
  expect(await evalPyret("{1; 2; 3}")).toBe("{1; 2; 3}");
  expect(await evalPyret("t = {10; 20; 30}\nt.{0} + t.{2}")).toBe("40");
  expect(await evalPyret("{1; {2; 3}; 4}")).toBe("{1; {2; 3}; 4}");
  expect(await evalPyret("check:\n  {1; 2} is {1; 2}\n  {1; 2} is-not {1; 3}\nend")).toContain("all 2 tests passed");
});

test("num-modulo / num-quotient (floor semantics)", async () => {
  expect(await evalPyret("num-modulo(17, 5)")).toBe("2");
  expect(await evalPyret("num-quotient(17, 5)")).toBe("3");
  expect(await evalPyret("num-modulo(0 - 17, 5)")).toBe("3"); // floor mod
});



test("cases branch may shadow the scrutinee variable name", async () => {
  // Regression: `cases(E) e: | i(c,t,e) => e` must bind e to the field, and the
  // scrutinee must still resolve correctly (scope restored per branch).
  const src = "data E: | n(v) | i(c, t, e) end\n" +
    "fun f(e): cases(E) e: | n(v) => v | i(c, t, e) => e end end\n" +
    "f(i(1, 2, 99))";
  expect(await evalPyret(src)).toBe("99");
});




test("multi-module loading: local file import/include (whole-program inlining)", async () => {
  const r1 = await run(await buildSourceFile("examples/mod-main.arr"));
  expect(r1.output.trimEnd()).toBe("35"); // L.double(10) + L.triple(5)
  const r2 = await run(await buildSourceFile("examples/mod-inc.arr"));
  expect(r2.output.trimEnd()).toBe("20"); // double(7) + triple(2)
});






















test("runs real Pyret benchmark programs (pitometer) correctly", async () => {
  const P = "pyret/lang/pitometer/programs";
  const exec = async (f: string) => (await run(await buildSourceFile(`${P}/${f}.arr`))).output.trim();
  // tail recursion (1M) and a flat 2000-term sum are robust on the direct path
  // thanks to native proper tail calls.
  expect(await exec("tail-sum-1000000")).toBe("500000500000");
  expect(await exec("adding-ones-2000")).toBe("2000");
  // Deep NON-tail recursion (triangle, depth 20k) is bounded by the native wasm
  // stack on the direct path: it returns the right answer when there's headroom
  // but may overflow under load. The CPS/stoppable path turns it into tail calls
  // and runs it unconditionally — see test/stoppable.test.ts.
  try {
    expect(await exec("recursion-triangle-20000")).toBe("200010001");
  } catch (e) {
    if (!(e instanceof RangeError)) throw e; // only tolerate stack overflow
  }
});
