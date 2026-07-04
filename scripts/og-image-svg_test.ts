import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildOgSvg, MESSAGE, THEMES } from "./og-image-svg.ts";

Deno.test("THEMES has exactly the five expected theme ids", () => {
  assertEquals(
    THEMES.map((t) => t.id).sort(),
    ["90s", "banana", "default", "gram", "whosapp"],
  );
});

Deno.test("buildOgSvg embeds the exact invite message for every theme", () => {
  for (const theme of THEMES) {
    const svg = buildOgSvg(theme);
    assertStringIncludes(svg, MESSAGE);
  }
});

Deno.test("buildOgSvg produces a well-formed 1200x630 SVG root", () => {
  const svg = buildOgSvg(THEMES[0]);
  assertStringIncludes(svg, '<svg width="1200" height="630"');
  assert(svg.trim().endsWith("</svg>"));
});

Deno.test("buildOgSvg uses each theme's declared text color", () => {
  for (const theme of THEMES) {
    const svg = buildOgSvg(theme);
    assertStringIncludes(svg, `fill="${theme.textColor}"`);
  }
});

Deno.test("buildOgSvg escapes XML-sensitive characters in the message", () => {
  const _svg = buildOgSvg({
    id: "test",
    textColor: "#000000",
    background: "",
  });
  // MESSAGE has no special characters today, so assert the escaper itself
  // is wired in by checking a hostile message is neutralized.
  const hostile = buildOgSvg({
    id: "test",
    textColor: "#000000",
    background: "",
    text: `<script>&"'`,
  } as never);
  assertStringIncludes(hostile, "&lt;script&gt;&amp;&quot;&#39;");
});
