provide *
# Shim for the JS-only `parse-pyret` module so the driver passes (compile-lib, repl)
# COMPILE. The real surface parser is Pyret's JS GLR tokenizer+parser; wiring actual
# parsing into the self-hosted compiler (via host FFI to that parser, or a Pyret
# parser) is a later phase. compile-lib/repl only reference `surface-parse`.

fun surface-parse(src, uri):
  raise("surface-parse: parser not yet wired into the self-hosted compiler")
end
