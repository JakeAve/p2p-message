/// Production bundle: client/app.ts → dist/app.js (minified ESM).
/// Run with `deno task build`. `main.ts` serves dist/app.js when present.
import * as esbuild from "esbuild";
import { denoPlugins } from "@luca/esbuild-deno-loader";

const repoRoot = new URL("../", import.meta.url);

await esbuild.build({
  plugins: [...denoPlugins()],
  entryPoints: [new URL("client/app.ts", repoRoot).pathname],
  outfile: new URL("dist/app.js", repoRoot).pathname,
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2022",
  sourcemap: false,
});
esbuild.stop();
console.log("Built dist/app.js");
