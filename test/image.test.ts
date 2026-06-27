import { test, expect } from "bun:test";
import { buildSource } from "../src/build.ts";
import { run } from "../src/runtime/run.ts";

async function evalPyret(src: string): Promise<string> {
  const { output } = await run(await buildSource(src));
  return output.trimEnd();
}

// Image VALUES are a lazy scene graph (data Image in the prelude). They render to
// text as `op(arg, ...)`; the IDE's web/image.js parses that and draws a canvas.

test("image constructors produce scene-graph values", async () => {
  expect(await evalPyret(`circle(50, "solid", "red")`)).toBe("circle(50, solid, red)");
  expect(await evalPyret(`rectangle(100, 60, "outline", "blue")`)).toBe("rectangle(100, 60, outline, blue)");
  expect(await evalPyret(`overlay(circle(40, "solid", "blue"), rectangle(100, 60, "outline", "red"))`))
    .toBe("overlay(circle(40, solid, blue), rectangle(100, 60, outline, red))");
});

test("image-width / image-height over the scene graph", async () => {
  expect(await evalPyret(`image-width(circle(50, "solid", "red"))`)).toBe("100");
  expect(await evalPyret(`image-height(rectangle(100, 60, "outline", "blue"))`)).toBe("60");
  // beside adds widths, takes max height
  expect(await evalPyret(`image-width(beside(circle(10, "solid", "red"), circle(20, "solid", "blue")))`)).toBe("60");
  expect(await evalPyret(`image-height(beside(circle(10, "solid", "red"), circle(20, "solid", "blue")))`)).toBe("40");
  // above stacks heights, takes max width
  expect(await evalPyret(`image-height(above(rectangle(30, 10, "solid", "red"), rectangle(30, 25, "solid", "blue")))`)).toBe("35");
  // scale multiplies
  expect(await evalPyret(`image-width(scale(3, square(20, "solid", "green")))`)).toBe("60");
});

test("user function named like an image constructor still works (shadowing)", async () => {
  // `triangle` is an image variant; a user fun must shadow it (regression: the
  // CPS transform misclassified it as a constructor).
  expect(await evalPyret(`fun triangle(n): if n <= 0: 0 else: n + triangle(n - 1) end end\ntriangle(5)`)).toBe("15");
});
