import "@std/dotenv/load";
import * as esbuild from "esbuild";
import { denoPlugins } from "@luca/esbuild-deno-loader";
import { handleConnection } from "./server/signaling-server.ts";
import { getIceServers } from "./server/ice-config.ts";

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

const server = Deno.serve({ port }, async (req, info) => {
  const url = new URL(req.url);

  if (url.pathname === "/ws") {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 400 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    handleConnection(socket, info.remoteAddr.hostname);
    return response;
  }

  if (url.pathname === "/api/ice-servers") {
    const config = await getIceServers();
    return new Response(JSON.stringify(config), {
      headers: { "content-type": "application/json" },
    });
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    return serveFile("./index.html");
  } else if (url.pathname === "/app.ts" || url.pathname === "/app.js") {
    return serveFile("./client/app.ts");
  }

  return new Response("Not Found", { status: 404 });
});

console.log(`listening on port ${server.addr.port}`);

Deno.addSignalListener("SIGINT", () => {
  esbuild.stop();
  Deno.exit();
});
