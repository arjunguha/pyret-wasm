provide *
# Pyret shim for the JS-only `pathlib` trove module. Path ops are only used by the
# compiler's DRIVER/config code (compile-structs default options, cli-module-loader,
# server) — not core compilation — so simple string-based implementations suffice for
# the WASM compiler. (Mirrors the source-map-lib shim approach.)

fun join(a, b):
  if string-length(a) == 0: b
  else: a + "/" + b
  end
end

fun resolve(p): p end

fun dirname(p):
  idx = last-slash(p, string-length(p) - 1)
  if idx < 0: "."
  else if idx == 0: "/"
  else: string-substring(p, 0, idx)
  end
end

fun basename(p):
  idx = last-slash(p, string-length(p) - 1)
  string-substring(p, idx + 1, string-length(p))
end

fun extname(p):
  b = basename(p)
  di = last-dot(b, string-length(b) - 1)
  if di <= 0: ""
  else: string-substring(b, di, string-length(b))
  end
end

# helpers: scan backwards for the last '/' or '.' (47 = '/', 46 = '.')
fun last-slash(p, i):
  if i < 0: -1
  else if string-to-code-point(string-substring(p, i, i + 1)) == 47: i
  else: last-slash(p, i - 1)
  end
end
fun last-dot(b, i):
  if i < 0: -1
  else if string-to-code-point(string-substring(b, i, i + 1)) == 46: i
  else: last-dot(b, i - 1)
  end
end
