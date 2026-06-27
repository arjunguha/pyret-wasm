#!/usr/bin/env bash
# Benchmark ORIGINAL Pyret (the 3rd config) on the same pitometer programs.
#
# Builds a node "runnable" standalone per program with the freshly-rebuilt phaseA
# compiler, then times pure `node` execution (best of 3) — isolating run-time the
# same way scripts/bench.ts does for the wasm configs. A trivial program gives the
# fixed node+runtime startup baseline to subtract.
#
# Prereqs (see memory original-pyret-baseline): node via nvm; pyret/lang deps incl
# `ws`; build/phaseA/pyret.jarr rebuilt from current src (the checked-in phase0 jarr
# is stale — `add-profiling`). See that memory for the one-time rebuild commands.
set -euo pipefail

LANG_DIR="$(cd "$(dirname "$0")/.." && pwd)/pyret/lang"
cd "$LANG_DIR"

NODE="${NODE:-$HOME/.nvm/versions/node/v24.18.0/bin/node}"
JARR="build/phaseA/pyret.jarr"
OUT="build/bench"; mkdir -p "$OUT"
export NODE_PATH="$LANG_DIR/node_modules"

[ -x "$NODE" ] || { echo "node not found at $NODE (install via nvm; set \$NODE)"; exit 1; }
[ -f "$JARR" ] || { echo "$JARR missing — rebuild phaseA (see memory original-pyret-baseline)"; exit 1; }

# Program sources (instrumented with print to force evaluation / show result).
mk() { printf '%s\n' "$2" > "$OUT/$1.arr"; }
mk trivial 'print(1)'
mk tailsum 'fun sum(n, sofar):
  if n <= 0: sofar else: sum(n - 1, sofar + n) end
end
print(sum(1000000, 0))'
mk triangle 'fun triangle(n):
  if n <= 0: 1 else: n + triangle(n - 1) end
end
print(triangle(20000))'
cp pitometer/programs/adding-ones-2000.arr "$OUT/addingones.arr"

build() {
  "$NODE" "$JARR" --build-runnable "$OUT/$1.arr" --outfile "$OUT/$1.js" \
    --builtin-js-dir src/js/trove/ --builtin-arr-dir src/arr/trove/ \
    --compiled-dir build/phaseA/compiled/ \
    --deps-file build/phaseA/bundled-node-compile-deps.js \
    --require-config src/scripts/standalone-configA.json >/dev/null 2>&1
}

timeit() { # best of 3 (after 1 warmup), milliseconds
  local js="$OUT/$1.js" best=999999 r s e
  for i in 1 2 3 4; do
    s=$(date +%s%N); "$NODE" "$js" >/dev/null 2>&1 || true; e=$(date +%s%N)
    r=$(( (e - s) / 1000000 ))
    [ $i -gt 1 ] && [ $r -lt $best ] && best=$r
  done
  printf "%s" "$best"
}

echo "Original Pyret baseline — best of 3 (total wall-clock, incl node+runtime startup)"
printf "%-26s %10s\n" "program" "total(ms)"
printf -- "-%.0s" {1..40}; echo
for p in trivial addingones triangle tailsum; do
  build "$p"
  printf "%-26s %10s\n" "$p" "$(timeit "$p")"
done
echo "(subtract the 'trivial' row to estimate compute-only time)"
