import { assert, assertEquals } from "@std/assert";
import { DEFAULT_THEME_ID, resolveTheme, THEMES } from "./themes.ts";

Deno.test("registry has unique ids, includes default and 90s, labels everything", () => {
  const ids = THEMES.map((t) => t.id);
  assertEquals(new Set(ids).size, ids.length);
  assert(ids.includes("default"));
  assert(ids.includes("90s"));
  assert(ids.includes("banana"));
  assert(ids.includes("gram"));
  assert(ids.includes("whosapp"));
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

/** The full token set every non-default theme must override (spec: three
 * app themes design, token contract). */
const REQUIRED_TOKENS = [
  "--bg",
  "--surface",
  "--surface-alt",
  "--text",
  "--muted",
  "--border",
  "--accent",
  "--accent-hover",
  "--accent-contrast",
  "--sent",
  "--sent-text",
  "--danger",
  "--ok",
  "--warn",
  "--radius",
  "--shadow",
  "--font-body",
  "--font-mono",
] as const;

const repoRoot = new URL("../../", import.meta.url);

/** First `:root[data-theme="<id>"] { ... }` block body in the file. */
function tokenBlock(css: string, id: string): string {
  const marker = `:root[data-theme="${id}"]`;
  const start = css.indexOf(marker);
  assert(start !== -1, `missing ${marker} token block`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

Deno.test("every non-default theme has a CSS file and a full token override", async () => {
  for (const theme of THEMES) {
    if (theme.id === DEFAULT_THEME_ID) continue;
    const cssUrl = new URL(`client/themes/${theme.id}.css`, repoRoot);
    let css: string;
    try {
      css = await Deno.readTextFile(cssUrl);
    } catch {
      throw new Error(`client/themes/${theme.id}.css does not exist`);
    }
    const block = tokenBlock(css, theme.id);
    for (const token of REQUIRED_TOKENS) {
      assert(
        block.includes(`${token}:`),
        `${theme.id}.css token block is missing ${token}`,
      );
    }
  }
});

Deno.test("theme CSS is lazy: index.html has no eager theme links and ids fit the route pattern", async () => {
  const indexHtml = await Deno.readTextFile(new URL("index.html", repoRoot));
  for (const theme of THEMES) {
    assert(
      !indexHtml.includes(`href="/themes/${theme.id}.css"`),
      `index.html must not eagerly link the "${theme.id}" stylesheet`,
    );
  }
  // The inline script in index.html and THEME_ROUTE in server/static.ts both
  // gate ids on this pattern; a mismatched id would never load.
  for (const theme of THEMES) {
    assert(
      /^[a-z0-9-]{1,32}$/.test(theme.id),
      `theme id "${theme.id}" does not match the /themes/ route pattern`,
    );
  }
});
