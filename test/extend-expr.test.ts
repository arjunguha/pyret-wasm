// `obj.{field: val, ...}` object update (extend-expr).
import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

async function out(src: string): Promise<string> {
  return (await run(await buildSource(src))).output.trim();
}

test("extend overrides an existing field", async () => {
  expect(await out("o = {x: 1, y: 2}\no.{y: 5}.y")).toBe("5");
});
test("extend keeps the other fields", async () => {
  expect(await out("o = {x: 1, y: 2}\no.{y: 5}.x")).toBe("1");
});
test("extend adds a new field", async () => {
  expect(await out("o = {x: 1}\no.{z: 9}.z")).toBe("9");
});
test("extend chained, last wins", async () => {
  expect(await out("o = {x: 1}\no.{x: 2}.{x: 3}.x")).toBe("3");
});
test("extend does not mutate the original", async () => {
  expect(await out("o = {x: 1}\nu = o.{x: 9}\no.x")).toBe("1");
});
