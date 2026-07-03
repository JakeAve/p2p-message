import { assert, assertEquals } from "@std/assert";
import { DEFAULT_THEME_ID, resolveTheme, THEMES } from "./themes.ts";

Deno.test("registry has unique ids, includes default and 90s, labels everything", () => {
  const ids = THEMES.map((t) => t.id);
  assertEquals(new Set(ids).size, ids.length);
  assert(ids.includes("default"));
  assert(ids.includes("90s"));
  assert(THEMES.some((t) => t.id === DEFAULT_THEME_ID));
  for (const t of THEMES) assert(t.label.length > 0);
});

Deno.test("resolveTheme passes valid ids through", () => {
  assertEquals(resolveTheme("default"), "default");
  assertEquals(resolveTheme("90s"), "90s");
});

Deno.test("resolveTheme maps unknown, empty, and null to the default", () => {
  assertEquals(resolveTheme("neon"), DEFAULT_THEME_ID);
  assertEquals(resolveTheme(""), DEFAULT_THEME_ID);
  assertEquals(resolveTheme(null), DEFAULT_THEME_ID);
});
