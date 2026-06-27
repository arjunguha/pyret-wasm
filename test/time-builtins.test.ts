// time-now() primitive: a deterministic 0 stub (used only for timing/telemetry).
import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

async function out(src: string): Promise<string> {
  return (await run(await buildSource(src))).output.trim();
}

test("time-now() returns a number (0 stub) usable in arithmetic", async () => {
  expect(await out("time-now()")).toBe("0");
  expect(await out("time-now() + 5")).toBe("5");
  expect(await out("fun elapsed(): block:\n  s = time-now()\n  e = time-now()\n  e - s\nend end\nelapsed()")).toBe("0");
});
