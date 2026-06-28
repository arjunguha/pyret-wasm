// CST serialization — shared by the Node + browser stoppable paths and the CPS
// driver. Kept in its OWN module (type-only CstNode import) so the BROWSER bundle
// can use it WITHOUT pulling in the seed compiler (build-stoppable-core.ts imports
// compile.ts → binaryen; main.ts must not).
import type { CstNode } from "./parser/parse-core.ts";

// Serialize a CST to a length-prefixed pre-order string the Pyret driver reads
// back (see read-node in self-host/cps-driver.arr — the two MUST stay in sync).
// Per node: "<nkids> <nameLen> <name><hasVal>[<valLen> <value>]" then its kids.
// Lengths are in Unicode code points (string values may be non-ASCII).
export function serializeCstNode(n: CstNode): string {
  const cps = (s: string) => [...s].length;
  let out = `${n.kids.length} ${cps(n.name)} ${n.name}`;
  if (n.value === undefined || n.value === null) out += "0";
  else out += `1${cps(n.value)} ${n.value}`;
  for (const k of n.kids) out += serializeCstNode(k);
  return out;
}
