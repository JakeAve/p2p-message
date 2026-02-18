import "@std/dotenv/load";
import * as esbuild from "esbuild";
import { denoPlugins } from "@luca/esbuild-deno-loader";
import { handleConnection } from "./server/signaling-server.ts";

const port = Number(Deno.env.get("PORT"));

const transpileCache = new Map<string, string>();

async function transpileTypeScript(filepath: string): Promise<string> {
  if (transpileCache.has(filepath)) {
    return transpileCache.get(filepath)!;
  }

  const result = await esbuild.build({
    plugins: [...denoPlugins()],
    entryPoints: [filepath],
    bundle: true,
    format: "esm",
    write: false,
    target: "es2020",
  });

  const js = result.outputFiles[0].text;
  transpileCache.set(filepath, js);
  return js;
}

async function serveFile(filepath: string): Promise<Response> {
  try {
    if (filepath.endsWith(".ts")) {
      const js = await transpileTypeScript(filepath);
      return new Response(js, {
        headers: {
          "content-type": "application/javascript; charset=utf-8",
          "cache-control": "no-cache",
        },
      });
    }

    const file = await Deno.readTextFile(filepath);
    let contentType = "text/plain";
    if (filepath.endsWith(".html")) {
      contentType = "text/html; charset=utf-8";
    } else if (filepath.endsWith(".js")) {
      contentType = "application/javascript; charset=utf-8";
    }

    return new Response(file, {
      headers: { "content-type": contentType },
    });
  } catch (error) {
    console.error(`Error serving ${filepath}:`, error);
    return new Response("File not found", { status: 404 });
  }
}

Deno.serve({ port }, (req) => {
  const url = new URL(req.url);

  if (req.headers.get("upgrade") === "websocket") {
    const { socket, response } = Deno.upgradeWebSocket(req);
    handleConnection(socket);
    return response;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    return serveFile("./index.html");
  } else if (url.pathname === "/app.ts" || url.pathname === "/app.js") {
    return serveFile("./client/app.ts");
  }

  return new Response("Not Found", { status: 404 });
});

console.log(`Server running on http://localhost:${port}`);
console.log(`WebSocket server running on ws://localhost:${port}`);

Deno.addSignalListener("SIGINT", () => {
  esbuild.stop();
  Deno.exit();
});
