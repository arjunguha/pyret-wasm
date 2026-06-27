provide *
# Pyret stub for the JS-only `type-logger` trove module. The type-checker calls
# LOG.log(name, payload) purely for diagnostics/telemetry; a no-op is fine for the
# WASM compiler. (Mirrors the source-map-lib / pathlib shim approach.)

fun log(name, payload): nothing end
fun log-error(s): nothing end
