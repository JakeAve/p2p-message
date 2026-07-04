/// One-off generator: renders the 5 per-theme OG share-preview PNGs into
/// client/og-images/. Run with `deno task og-images` whenever the message
/// or theme styling in og-image-svg.ts changes, then commit the output.
/// Never imported by server/ or client/ runtime code.
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { buildOgSvg, THEMES } from "./og-image-svg.ts";

const RESVG_WASM_URL =
  "https://cdn.jsdelivr.net/npm/@resvg/resvg-wasm@2.6.2/index_bg.wasm";

const repoRoot = new URL("../", import.meta.url);

const [wasmRes, fontBytes] = await Promise.all([
  fetch(RESVG_WASM_URL),
  Deno.readFile(
    new URL("./assets/DejaVuSans-Bold.ttf", import.meta.url),
  ),
]);
await initWasm(wasmRes);

for (const theme of THEMES) {
  const svg = buildOgSvg(theme);
  const resvg = new Resvg(svg, {
    font: {
      fontBuffers: [fontBytes],
      defaultFontFamily: "DejaVu Sans",
    },
  });
  const png = resvg.render().asPng();
  const outPath = new URL(`client/og-images/${theme.id}.png`, repoRoot);
  await Deno.writeFile(outPath, png);
  console.log(`wrote ${outPath.pathname} (${png.byteLength} bytes)`);
}
