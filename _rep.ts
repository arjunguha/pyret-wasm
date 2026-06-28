import { runSourceSelfHosted } from "/media/external0/arjun/repos/arjunguha/pyret-wasm/.claude/worktrees/agent-ac9ddf9d443d8e1fc/src/build-selfhosted.ts";
const cases: [string,string][] = [
  ["shadow-var-ctor-call", "data D: | str(s, n, b) | mt end\nshadow str = lam(s): str(s, 0, false) end\nif str(\"x\").s == \"x\": 0 else: 1 / 0 end"],
  ["toplevel-val-binds-shadow", "data D: | str(s, n, b) | mt end\nshadow str = lam(s): str(s, 0, false) end\nlp = str(\"(\")\nif lp.s == \"(\": 0 else: 1 / 0 end"],
  ["data-sharing-plus-at-init", "data D:\n | dd(n)\nsharing:\n method _plus(self, o): dd(self.n + o.n) end\nend\nshadow dd = lam(n): dd(n) end\na = dd(1)\nb = dd(2)\nc = a + b\nif c.n == 3: 0 else: 1 / 0 end"],
];
for (const [name, src] of cases) {
  try { await runSourceSelfHosted(src); console.log("OK  ", name); }
  catch(e){ console.log("FAIL", name, "->", String((e as Error).message).slice(0,55)); }
}
