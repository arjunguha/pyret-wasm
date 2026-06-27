provide *
# WASM self-hosting STUB of Pyret's JS-implemented source-map-lib.
# Source maps are not needed for WASM output, so the map object is a no-op and
# to-string-with-source-map returns the empty string. Satisfies js-ast.arr's
# sourcemap-printer call sites (new-map/start-node/end-node/string/get).

fun new-map(line, col, uri, name):
  {
    method start-node(self, l, c, u, n): nothing end,
    method end-node(self): nothing end,
    method string(self, s): nothing end,
    method get(self): nothing end
  }
end

fun to-string-with-source-map(m, uri): "" end
