// The standard prelude — written in Pyret and compiled by our own backend. It is a
// SHARED artifact: the TS seed, the Pyret-port compiler, and the CPS Pyret→Pyret
// transform all compile/transform this same source. The single source of truth is
// `prelude.arr` (next to this file); we import it as text so it bundles for the
// browser too. Edit prelude.arr, not a string here.
//
// `[list: 1, 2, 3]` construct syntax is desugared by the compiler into link/empty
// using the List type defined in the prelude.

import PRELUDE_SRC from "./prelude.arr" with { type: "text" };
export { PRELUDE_SRC };
