import file("../../self-compiler/compiler/parse-pyret.arr") as P
import ast as A

# `import file("...") as F` -> s-import of an s-special-import.
prog = P.surface-parse("", "test")
imp = prog.imports.first
print("implabel=" + imp.label())
print("filelabel=" + imp.file.label())
print("kind=" + imp.file.kind)
print("arg0=" + imp.file.args.first)
print("alias=" + imp.name.s)
