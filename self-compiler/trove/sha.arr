provide *
# WASM self-hosting STUB of Pyret's JS-implemented `sha` trove. The compiler uses
# sha256 only as a stable cache/module key (not for security), so this is a simple
# deterministic, non-cryptographic rolling hash — collision-rare enough for keys.
# (Mirrors the source-map-lib / pathlib / type-logger shim approach.)

fun sha256(s):
  cps = string-to-code-points(s)
  h1 = foldl(lam(acc, c): num-modulo(((acc * 31) + c) + 1, 1000000007) end, 7, cps)
  h2 = foldl(lam(acc, c): num-modulo(((acc * 131) + c) + 1, 998244353) end, 17, cps)
  h3 = foldl(lam(acc, c): num-modulo(((acc * 1009) + c) + 1, 1000000009) end, 23, cps)
  (((num-to-string(h1) + "x") + num-to-string(h2)) + "x") + num-to-string(h3)
end
