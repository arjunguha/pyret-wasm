# Tiny probe for run.ts memory auto-grow: read the host-supplied source and
# print its length. With a >64KB payload this exercises read_source_into writing
# past the 1-page initial linear memory (must auto-grow, else "Length out of
# range of buffer"). No parsing here, so it isolates the memory fix from the
# parser's own (separately-tracked) recursion limits.
src = read-source()
print(to-string(string-length(src)))
