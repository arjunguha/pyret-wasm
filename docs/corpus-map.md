# Corpus Feature Map

Static scan of `test-corpus/` (339 `.arr` files). Tokens detected by text/regex matching only — no compilation. Tier = highest-difficulty feature a file uses, with purpose-of-test overrides (everything under `type-check/bad/`, `type-check/should-not/`, and `io-tests/` forced to Tier 4 since those tests *expect* type errors or need host IO).

## Tier summary

| Tier | Count | %  | Description |
|------|-------|----|-------------|
| 0 | 19 | 6% | Pure arithmetic / `fun` / `if` / `let` / recursion. Reachable very soon. |
| 1 | 71 | 21% | Core language: `data`/`cases`, lists, strings, closures, `check`, `raises`, `num-*`. |
| 2 | 104 | 31% | Adds objects, tuples, `for`, `var`/`:=`, modules. |
| 3 | 21 | 6% | Needs sets or string-dicts. |
| 4 | 124 | 37% | Needs a type-checker (type-error tests), charts, IO/files, tables, or reactors — host features our runtime will not have early. |

## Feature frequency (highest leverage first)

| Feature | # tests | % of corpus |
|---------|---------|-------------|
| type annotations (`::`, `data ... <`) | 193 | 57% |
| modules (`import`/`include`/`provide`) | 164 | 48% |
| `data` / `cases` | 128 | 38% |
| `check:`/`examples:`/`where:` | 100 | 29% |
| lists (`[list:`, `link`, `empty`) | 91 | 27% |
| `lam` / closures | 79 | 23% |
| `string-*` builtins | 52 | 15% |
| `raises` | 41 | 12% |
| `num-*` builtins | 35 | 10% |
| tuples `{..;..}` | 34 | 10% |
| `for` loops | 33 | 10% |
| objects / `method` | 32 | 9% |
| string-dicts | 31 | 9% |
| `var` / `:=` | 30 | 9% |
| charts / image / plotting | 22 | 6% |
| `when` | 19 | 6% |
| IO / files | 16 | 5% |
| tables / `load-table` | 14 | 4% |
| sets (`[set:`/`[list-set:`) | 8 | 2% |
| `reactor` | 6 | 2% |
| `ask:` | 2 | 1% |
| `spy` | 2 | 1% |

> Note: `type annotations` and `modules` top the list but are largely *structural* — no type-checker is required (annotations can be erased), and most module use is `import`/`provide` of stdlib. The genuine codegen unlocks are `data`/`cases`, lists, closures, the testing forms (`check`/`raises`), and string/num builtins.

## Per-tier file lists

### Tier 0 (19 files)

- `type-check/good/a-pred.arr` — typeann
- `type-check/good/blank-arg.arr` — typeann
- `type-check/good/data-unify-methods.arr` — (none)
- `type-check/good/equality.arr` — (none)
- `type-check/good/fact.arr` — typeann
- `type-check/good/if.arr` — typeann
- `type-check/good/letrec.arr` — typeann
- `type-check/good/obj-check.arr` — typeann
- `type-check/good/obj-infer.arr` — typeann
- `type-check/good/obj-lub.arr` — typeann
- `type-check/good/option.arr` — typeann
- `type-check/good/polymorphic-type-alias-application.arr` — typeann
- `type-check/good/polymorphic-type-alias-chain.arr` — typeann
- `type-check/good/polymorphic-type-alias-transitive-application.arr` — typeann
- `type-check/good/shadowing-doesnt-change-type.arr` — typeann
- `type-check/good/simple.arr` — (none)
- `type-check/good/type-instantiation.arr` — typeann
- `type-check/should/dot-bottom.arr` — (none)
- `type-check/should/underscore.arr` — typeann

### Tier 1 (71 files)

- `pyret/regression/cases-expr-parse.arr` — data_cases, lists
- `pyret/regression/check-scope.arr` — check
- `pyret/regression/double-desugar-extend.arr` — check, lam
- `pyret/regression/empty-concat-list-and-block.arr` — check, data_cases, lists, raises, typeann
- `pyret/regression/flat-refinement.arr` — check, data_cases, typeann
- `pyret/regression/is-not-uses-equal-always.arr` — check
- `pyret/regression/map4_n.arr` — lists
- `pyret/regression/seq-of-lettable.arr` — lam
- `pyret/regression/sloppy-list-filter.arr` — check, lam, lists, raises
- `pyret/tests/test-adaptive-simpson.arr` — num
- `pyret/tests/test-cases.arr` — check, data_cases, raises
- `pyret/tests/test-constants.arr` — check
- `pyret/tests/test-examples.arr` — check
- `pyret/tests/test-record-concat.arr` — check, data_cases
- `pyret/tests/test-refined-refs.arr` — data_cases, raises, typeann
- `pyret/tests/test-refs.arr` — data_cases, lists, raises
- `pyret/tests/test-within.arr` — data_cases, lam, lists, num, raises
- `pyret/tests/use/test-essentials.arr` — check
- `type-check/good/ann-in-case-branch.arr` — data_cases, typeann
- `type-check/good/closure.arr` — lam, typeann
- `type-check/good/d-dx.arr` — lam, typeann
- `type-check/good/data-basic-infer.arr` — data_cases, typeann
- `type-check/good/data-basic-only-else.arr` — data_cases, typeann
- `type-check/good/data-basic-uses-else.arr` — data_cases, typeann
- `type-check/good/data-basic.arr` — data_cases, typeann
- `type-check/good/data-common-field.arr` — data_cases, typeann
- `type-check/good/data-constructorAsFun-infer.arr` — data_cases, lists, typeann
- `type-check/good/data-constructorAsFun-instantiate.arr` — data_cases, lists, typeann
- `type-check/good/data-constructorAsSingleton-infer.arr` — data_cases, lists, typeann
- `type-check/good/data-constructorAsSingleton-instantiate.arr` — data_cases, lists, typeann
- `type-check/good/data-covariant.arr` — data_cases, lists, typeann
- `type-check/good/data-higherOrder-infer.arr` — data_cases, lists, typeann
- `type-check/good/data-higherOrder-instantiate.arr` — data_cases, lists, typeann
- `type-check/good/data-polymorphic-infer.arr` — data_cases, lists, typeann
- `type-check/good/data-polymorphic-instantiate.arr` — data_cases, lists, typeann
- `type-check/good/data-polymorphic-recursive-infer.arr` — data_cases, lists, typeann
- `type-check/good/data-polymorphic-recursive-instantiate.arr` — data_cases, lists, typeann
- `type-check/good/data-polymorphic-ref.arr` — data_cases, typeann
- `type-check/good/data-recursive.arr` — data_cases, typeann
- `type-check/good/data-sharing-non-method.arr` — data_cases, typeann
- `type-check/good/empty-data-definition.arr` — data_cases
- `type-check/good/forall-lub.arr` — lam, typeann
- `type-check/good/fun.arr` — num, typeann
- `type-check/good/id.arr` — lam, typeann
- `type-check/good/int-list-map.arr` — data_cases, lists, typeann
- `type-check/good/lam-forall-check.arr` — lam, typeann
- `type-check/good/lam.arr` — lam, typeann
- `type-check/good/lazy-maker.arr` — lam, typeann
- `type-check/good/let.arr` — num, typeann
- `type-check/good/list-of-options.arr` — data_cases, lists
- `type-check/good/list.arr` — lists, typeann
- `type-check/good/magic-plus.arr` — num, string, typeann
- `type-check/good/map.arr` — data_cases, lists, typeann
- `type-check/good/numbers.arr` — num, string, typeann
- `type-check/good/obj-fun-check.arr` — lam, typeann
- `type-check/good/occurrence-typing.arr` — data_cases, typeann
- `type-check/good/option-and-then.arr` — lam, num, typeann
- `type-check/good/polymorphic-data-field-access.arr` — data_cases, typeann
- `type-check/good/raw-array.arr` — lam, typeann
- `type-check/good/ref-set.arr` — data_cases, typeann
- `type-check/good/subtyping-and-bottom.arr` — data_cases, lam, typeann
- `type-check/good/test-inference.arr` — check, data_cases, lam, lists, string, typeann
- `type-check/good/tests-because.arr` — check, num, raises, typeann
- `type-check/good/underscore.arr` — lam, lists
- `type-check/good/unqualified-forall-data.arr` — data_cases, typeann
- `type-check/good/use-param.arr` — num, typeann
- `type-check/good/where.arr` — check, typeann
- `type-check/should/lambda-infer.arr` — lam, typeann
- `type-check/should/lambda-instantiate.arr` — lam, typeann
- `type-check/should/lambda-test-inference.arr` — lam, typeann
- `type-check/should/obj-glb.arr` — lam, typeann

### Tier 2 (104 files)

- `all.arr` — modules
- `lib-test/lib-test-main.arr` — modules
- `pyret/regression/anf-of-vars.arr` — check, raises, var
- `pyret/regression/bogus-global-type-name.arr` — modules, typeann
- `pyret/regression/curried-funs.arr` — check, lam, lists, modules, raises
- `pyret/regression/duplicate-check-block-report.arr` — check, modules, num
- `pyret/regression/empty-check-block.arr` — check, modules
- `pyret/regression/escaping-module-uris.arr` — data_cases, modules
- `pyret/regression/get-assignments-var-as-expr.arr` — check, lists, var
- `pyret/regression/immediate-app-return-ann.arr` — check, lam, modules, raises
- `pyret/regression/import-module-defining-but-not-exporting-data.arr` — check, modules
- `pyret/regression/method-scope.arr` — check, modules, objects, typeann
- `pyret/regression/named-arrow-ann.arr` — lam, modules, typeann
- `pyret/regression/pretty-print-instantiate.arr` — check, lists, modules
- `pyret/regression/proto-fields.arr` — modules, raises
- `pyret/regression/provides-less-than-data.arr` — data_cases, modules, typeann
- `pyret/regression/random-arg-typecheck.arr` — check, modules, raises
- `pyret/regression/random-bogus-range.arr` — for
- `pyret/regression/render-reason-wrong-op.arr` — check, lam, modules
- `pyret/regression/stack-safe-each-loop.arr` — check, lam, var
- `pyret/regression/tail-recursion-arg-order.arr` — check, data_cases, lam, var
- `pyret/regression/tc-internal-err.arr` — modules
- `pyret/regression/toplevel-data.arr` — check, data_cases, for, lam, modules
- `pyret/regression/using-spy-with-var.arr` — spy, var
- `pyret/regression/var-statement.arr` — var
- `pyret/regression/weave-tuple.arr` — check, tuples, typeann
- `pyret/regression/zero.arr` — check, modules, string
- `pyret/test-parse-helper.arr` — data_cases, lists, modules, raises, typeann, var, when
- `pyret/tests/data1.arr` — data_cases, modules
- `pyret/tests/data2.arr` — data_cases, modules
- `pyret/tests/defines-vars.arr` — modules, var
- `pyret/tests/exporter.arr` — modules, var
- `pyret/tests/modules/alias-x.arr` — modules
- `pyret/tests/modules/aliased-name-re-provided.arr` — modules
- `pyret/tests/modules/aliased-names-same-type.arr` — data_cases, modules
- `pyret/tests/modules/import-data.arr` — check, data_cases, modules, typeann
- `pyret/tests/modules/import-datatype-as-type-alias.arr` — check, modules, typeann
- `pyret/tests/modules/import-re-provided.arr` — check, modules, typeann
- `pyret/tests/modules/include-shadow-same.arr` — check, modules
- `pyret/tests/modules/provide-arrow-using-datatype.arr` — data_cases, modules, typeann
- `pyret/tests/modules/provide-as-simple.arr` — modules
- `pyret/tests/modules/provide-data-star.arr` — data_cases, modules, typeann
- `pyret/tests/modules/provide-data-with-provide-star.arr` — data_cases, modules, objects
- `pyret/tests/modules/provide-data.arr` — data_cases, modules, typeann
- `pyret/tests/modules/provide-datatype-as-type-alias.arr` — data_cases, modules
- `pyret/tests/modules/provide-provide-x.arr` — modules
- `pyret/tests/modules/provide-type-as-simple.arr` — modules, tuples
- `pyret/tests/modules/provide-x.arr` — modules
- `pyret/tests/modules/re-provide-data.arr` — data_cases, modules
- `pyret/tests/modules/re-re-provide-data.arr` — data_cases, modules
- `pyret/tests/modules/test-aliased-names-same-type.arr` — check, modules, typeann
- `pyret/tests/modules/test-import-arrow-using-datatype.arr` — check, modules
- `pyret/tests/modules/test-import-data-from-data-star.arr` — check, data_cases, modules, typeann
- `pyret/tests/modules/test-import-re-provided-data.arr` — check, data_cases, modules, typeann
- `pyret/tests/modules/test-import-re-re-provide-data.arr` — check, data_cases, modules, typeann
- `pyret/tests/modules/test-provide-as-simple.arr` — check, modules
- `pyret/tests/modules/test-provide-type-as-simple.arr` — check, modules, tuples, typeann
- `pyret/tests/provider.arr` — modules
- `pyret/tests/test-array.arr` — check, data_cases, for, lam, lists, modules, num, objects, raises, string, tuples, typeann, when
- `pyret/tests/test-binops.arr` — check, data_cases, lam, lists, modules, num, objects, string
- `pyret/tests/test-compile-errors.arr` — check, data_cases, for, lam, lists, modules, num, objects, string, tuples, typeann, when
- `pyret/tests/test-constants-scope.arr` — check, modules
- `pyret/tests/test-dup-names.arr` — check, modules
- `pyret/tests/test-each-loop.arr` — check, lam, modules, var
- `pyret/tests/test-flatness.arr` — data_cases, lam, lists, modules, num, string, tuples, typeann
- `pyret/tests/test-import-variable.arr` — check, modules, var
- `pyret/tests/test-import.arr` — modules, raises
- `pyret/tests/test-include-block.arr` — check, lists, modules, typeann
- `pyret/tests/test-letrec.arr` — check, data_cases, lam, modules
- `pyret/tests/test-lists.arr` — check, data_cases, for, lam, lists, modules, num, raises, tuples
- `pyret/tests/test-match.arr` — check, data_cases, lam, modules, raises
- `pyret/tests/test-math.arr` — lists, modules, raises
- `pyret/tests/test-matrices.arr` — lam, lists, modules, num, raises, tuples, typeann
- `pyret/tests/test-matrices2.arr` — for, lam, lists, modules, num, raises, when
- `pyret/tests/test-npm-import.arr` — check, modules
- `pyret/tests/test-numbers.arr` — check, for, lam, modules, num, raises, string
- `pyret/tests/test-rec.arr` — data_cases, lam, lists, modules, var
- `pyret/tests/test-roughnum.arr` — lam, modules, num, objects, raises
- `pyret/tests/test-rounding.arr` — for, lists, num, var, when
- `pyret/tests/test-s-exp.arr` — check, data_cases, for, lam, lists, modules, num, raises, typeann, when
- `pyret/tests/test-strings.arr` — check, for, lists, modules, raises, string
- `pyret/tests/test-tail-call.arr` — check, data_cases, lam, lists, modules, num, raises, typeann, var
- `pyret/tests/test-timing.arr` — check, modules, tuples
- `pyret/tests/use/test-simple-use.arr` — check, modules
- `type-check/good/_plus.arr` — data_cases, lists, objects, typeann
- `type-check/good/basic-check.arr` — check, modules
- `type-check/good/data-methods.arr` — data_cases, lam, objects, typeann
- `type-check/good/export.arr` — data_cases, modules, typeann
- `type-check/good/function-tuple-bool-to-any.arr` — tuples, typeann
- `type-check/good/import-refined-data.arr` — modules
- `type-check/good/imports.arr` — data_cases, modules, typeann
- `type-check/good/lazy-lists.arr` — data_cases, lam, lists, modules, typeann
- `type-check/good/local-import.arr` — data_cases, modules, typeann
- `type-check/good/module-alias.arr` — data_cases, modules, typeann
- `type-check/good/obj-methods.arr` — objects, typeann
- `type-check/good/polymorphic-newtype.arr` — lists, modules, typeann
- `type-check/good/provide-data.arr` — data_cases, modules, objects, typeann
- `type-check/good/references.arr` — data_cases, typeann, var
- `type-check/good/set-include.arr` — modules
- `type-check/good/spy.arr` — check, data_cases, for, lists, spy, typeann
- `type-check/good/string-to-number.arr` — data_cases, modules, string, typeann
- `type-check/good/tests.arr` — check, modules, raises, typeann
- `type-check/good/tuple-matches-function-ann.arr` — tuples, typeann
- `type-check/good/tuple-regression.arr` — check, data_cases, for, lists, modules, num, objects, tuples, typeann, var

### Tier 3 (21 files)

- `pyret/main.arr` — modules, string, string_dict
- `pyret/regression.arr` — lists, modules, string, string_dict
- `pyret/regression/string-dict-equality.arr` — check, lam, modules, string, string_dict
- `pyret/tests/modules/double-rename.arr` — modules, string, string_dict
- `pyret/tests/modules/test-double-rename.arr` — check, modules, string, string_dict, typeann
- `pyret/tests/provide-modules.arr` — modules, string, string_dict
- `pyret/tests/test-builtin-locator.arr` — check, data_cases, lists, modules, objects, sets, string, string_dict, typeann
- `pyret/tests/test-compile-lib.arr` — check, data_cases, for, lam, lists, modules, num, objects, raises, string, string_dict, typeann
- `pyret/tests/test-constructors.arr` — check, for, lam, lists, modules, num, raises, string, string_dict, var, when
- `pyret/tests/test-equality.arr` — check, data_cases, for, lam, lists, modules, objects, raises, sets, var, when
- `pyret/tests/test-json.arr` — lam, lists, modules, string, string_dict
- `pyret/tests/test-module-syntax.arr` — check, modules, string, string_dict, typeann
- `pyret/tests/test-output.arr` — data_cases, for, lam, lists, modules, objects, sets, when
- `pyret/tests/test-str-dict.arr` — data_cases, for, lists, modules, num, objects, raises, sets, string, string_dict, tuples, var, when
- `pyret/tests/test-string-dict.arr` — for, lists, modules, objects, raises, sets, string, string_dict, var, when
- `type-check/good/double-rename.arr` — modules, string, string_dict
- `type-check/good/sets.arr` — sets
- `type-check/good/str-dict.arr` — modules, string, string_dict, tuples, typeann
- `type-check/good/string-dict-keys-type.arr` — check, modules, string, string_dict, typeann
- `type-check/good/string-dict.arr` — modules, string, string_dict, typeann
- `type-check/good/test-double-rename.arr` — check, modules, string, string_dict, typeann

### Tier 4 (124 files)

- `io-tests/tests/library-code.arr` — data_cases, modules
- `io-tests/tests/nested/imports-library-with-dotdot.arr` — data_cases, modules
- `io-tests/tests/nested/library-code.arr` — modules
- `io-tests/tests/test-csv-table-file-with-url.arr` — io, modules, tables
- `io-tests/tests/test-csv-table-url-with-path.arr` — io, modules, tables
- `io-tests/tests/test-csv-table-url.arr` — check, io, modules, tables
- `io-tests/tests/test-import-url-both-present-all-remote.arr` — (none)
- `io-tests/tests/test-import-url-both-present.arr` — modules
- `io-tests/tests/test-import-url-remote-fail.arr` — modules
- `io-tests/tests/test-import-url-remote.arr` — modules
- `io-tests/tests/test-import-url.arr` — modules
- `io-tests/tests/test-imports-library-and-nested.arr` — check, modules
- `io-tests/tests/test-input-empty-prompt.arr` — modules
- `io-tests/tests/test-input-incorrect-prompt-input-type.arr` — modules
- `io-tests/tests/test-input-missing-prompt-input.arr` — modules
- `io-tests/tests/test-input-non-empty-prompt.arr` — modules
- `pyret/main2.arr` — charts, io, modules, reactor, string, string_dict
- `pyret/regression/parens-after-comments.arr` — charts, lists, modules, typeann
- `pyret/regression/table-reduce.arr` — check, modules, tables
- `pyret/regression/table-row-row-length-mismatch.arr` — check, data_cases, lam, modules, tables
- `pyret/standalone/importer.arr` — charts, io, lists, modules, string, string_dict
- `pyret/test-compile-helper.arr` — charts, data_cases, for, lam, lists, modules, objects, string, string_dict, typeann, var
- `pyret/tests/modules/test-provide-data-with-provide-star.arr` — charts, check, data_cases, modules
- `pyret/tests/test-bar-chart.arr` — charts, for, lam, lists, modules, num, string
- `pyret/tests/test-charts.arr` — charts, lam, lists, modules, raises
- `pyret/tests/test-contracts.arr` — check, data_cases, for, lam, lists, modules, num, objects, string, tables, tuples, typeann, when
- `pyret/tests/test-csv-table.arr` — check, io, lam, lists, modules, num, raises, string, tables
- `pyret/tests/test-error-rendering.arr` — data_cases, lists, modules, string, tables
- `pyret/tests/test-errors.arr` — charts, check, data_cases, io, lam, lists, modules, num, objects, string, string_dict, when
- `pyret/tests/test-file-locators.arr` — data_cases, io, lam, lists, modules, objects, string, string_dict, typeann, var
- `pyret/tests/test-file.arr` — charts, check, io, lists, modules, string
- `pyret/tests/test-filesystem.arr` — check, io, lists, modules, raises, string
- `pyret/tests/test-format.arr` — check, io, lists, modules
- `pyret/tests/test-images.arr` — charts, check, data_cases, lam, lists, modules, raises
- `pyret/tests/test-include.arr` — charts, check, data_cases, for, lam, lists, modules, objects, string, string_dict, typeann
- `pyret/tests/test-modules.arr` — charts, check, data_cases, for, io, lam, lists, modules, objects, string, string_dict, tuples, typeann, var, when
- `pyret/tests/test-parse-errors.arr` — charts, for, lam, lists, modules, objects, tuples, typeann, when
- `pyret/tests/test-parse.arr` — ask, charts, check, data_cases, for, io, lam, lists, modules, reactor, tables, tuples, typeann, var
- `pyret/tests/test-path.arr` — charts, check, lists, modules
- `pyret/tests/test-pprint.arr` — check, data_cases, for, io, lists, modules, num, objects, string, string_dict, typeann
- `pyret/tests/test-reactor.arr` — charts, lam, lists, modules, raises, reactor, tables, typeann
- `pyret/tests/test-repl.arr` — charts, check, data_cases, for, lam, lists, modules, sets, string, string_dict, tuples, typeann, var, when
- `pyret/tests/test-sets.arr` — charts, check, data_cases, for, lam, lists, modules, sets, typeann, var, when
- `pyret/tests/test-statistics.arr` — lists, modules, num, raises, string, tables, tuples
- `pyret/tests/test-tables.arr` — check, for, lam, lists, modules, num, objects, raises, string, tables, tuples, typeann, var
- `pyret/tests/test-tuple.arr` — charts, check, data_cases, for, lists, modules, num, objects, raises, tuples, typeann, var
- `pyret/tests/test-well-formed.arr` — charts, check, data_cases, for, io, lam, lists, modules, num, objects, raises, reactor, string, tables, tuples, typeann, var, when
- `type-check/bad/_plus-missing.arr` — modules, string, string_dict
- `type-check/bad/a-pred.arr` — typeann
- `type-check/bad/ask.arr` — ask, typeann
- `type-check/bad/bad-make.arr` — lam, typeann
- `type-check/bad/bad-reactor.arr` — lam, reactor, typeann
- `type-check/bad/bad-tuple-access.arr` — (none)
- `type-check/bad/bad-type-instantiation.arr` — typeann
- `type-check/bad/cases-on-number.arr` — data_cases
- `type-check/bad/cases-singleton-1.arr` — data_cases, typeann
- `type-check/bad/cases-singleton-2.arr` — data_cases, typeann
- `type-check/bad/data-extra-bindings.arr` — data_cases, typeann
- `type-check/bad/data-is-object.arr` — data_cases, typeann
- `type-check/bad/data-missing-branch.arr` — data_cases, typeann
- `type-check/bad/data-unify-methods.arr` — check, data_cases, objects, typeann
- `type-check/bad/data-unncessary-constructor.arr` — data_cases, typeann
- `type-check/bad/data-unncessary-else.arr` — data_cases, typeann
- `type-check/bad/dot-doesnt-deref-check.arr` — data_cases, typeann
- `type-check/bad/dot-doesnt-deref-synth.arr` — data_cases, typeann
- `type-check/bad/error-in-array.arr` — lam, typeann
- `type-check/bad/forall-lub.arr` — lam, typeann
- `type-check/bad/fun.arr` — typeann
- `type-check/bad/function-number-not-tuple.arr` — tuples, typeann
- `type-check/bad/function-tuple-any-to-bool.arr` — tuples, typeann
- `type-check/bad/function-tuple-not-function.arr` — tuples, typeann
- `type-check/bad/function-tuple-string-to-bool.arr` — tuples, typeann
- `type-check/bad/import-refined-data1.arr` — modules
- `type-check/bad/import-refined-data2.arr` — modules
- `type-check/bad/lambda-instantiate.arr` — lam, typeann
- `type-check/bad/let.arr` — typeann
- `type-check/bad/letrec.arr` — typeann
- `type-check/bad/lib/provide-data.arr` — data_cases, modules, objects, typeann
- `type-check/bad/list-of-options-conflict-2.arr` — data_cases, lists
- `type-check/bad/list-of-options-conflict.arr` — data_cases, lists
- `type-check/bad/list.arr` — lists, typeann
- `type-check/bad/local-function.arr` — data_cases, lists, typeann
- `type-check/bad/local-import.arr` — modules, typeann
- `type-check/bad/magic-plus-1.arr` — (none)
- `type-check/bad/magic-plus-2.arr` — (none)
- `type-check/bad/maker-for-non-object.arr` — typeann
- `type-check/bad/multiple-errors.arr` — typeann
- `type-check/bad/mutual-rec.arr` — typeann
- `type-check/bad/newtype.arr` — typeann
- `type-check/bad/no-maker.arr` — (none)
- `type-check/bad/number-is-not-tuple.arr` — tuples, typeann
- `type-check/bad/obj-check.arr` — typeann
- `type-check/bad/obj-glb.arr` — lam, typeann
- `type-check/bad/obj-infer.arr` — typeann
- `type-check/bad/obj-lub.arr` — typeann
- `type-check/bad/obj-update-incorrect-type.arr` — data_cases, typeann
- `type-check/bad/obj-update-non-ref.arr` — data_cases, typeann
- `type-check/bad/plus-in-fun.arr` — for, typeann, var
- `type-check/bad/raw-array.arr` — lam, typeann
- `type-check/bad/ref-fail.arr` — data_cases, typeann
- `type-check/bad/ref-not-ref.arr` — data_cases, typeann
- `type-check/bad/str-dict.arr` — modules, string, string_dict, tuples, typeann
- `type-check/bad/str-dict2.arr` — modules, string, string_dict, tuples
- `type-check/bad/test-inference.arr` — check, data_cases, lam, lists, string, typeann
- `type-check/bad/test-is.arr` — check
- `type-check/bad/test-raises.arr` — check, raises
- `type-check/bad/test-refinement.arr` — check, typeann
- `type-check/bad/too-few-args.arr` — typeann
- `type-check/bad/too-many-args.arr` — typeann
- `type-check/bad/tuple-is-not-booleans.arr` — tuples, typeann
- `type-check/bad/tuple-is-not-num.arr` — tuples, typeann
- `type-check/bad/tuple-length-binding.arr` — tuples
- `type-check/bad/tuple-wrong-types.arr` — tuples, typeann
- `type-check/good/good-reactor.arr` — charts, lam, modules, reactor, typeann
- `type-check/good/table.arr` — tables, typeann
- `type-check/main.arr` — data_cases, for, io, lam, lists, modules, objects, string, string_dict, typeann, when
- `type-check/should-not/basic-check.arr` — check, typeann
- `type-check/should-not/data-contravariant.arr` — data_cases, lists, typeann
- `type-check/should-not/data-covariant.arr` — data_cases, lists, typeann
- `type-check/should-not/data-invariant.arr` — data_cases, typeann
- `type-check/should-not/data-phantom.arr` — data_cases, lists, typeann
- `type-check/should-not/methods-contested-extension.arr` — objects
- `type-check/should-not/obj-update.arr` — data_cases, typeann
- `type-check/should/image.arr` — charts, modules
