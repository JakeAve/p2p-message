import "@std/dotenv/load";
import { handleStaticRequest, withSecurityHeaders } from "./server/static.ts";
import { handleConnection } from "./server/signaling-server.ts";
import { getIceServers } from "./server/ice-config.ts";

export async function handler(
  req: Request,
  info?: Deno.ServeHandlerInfo,
): Promise<Response> {
  return withSecurityHeaders(await route(req, info));
}

async function route(
  req: Request,
  info?: Deno.ServeHandlerInfo,
): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/ws") {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 400 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    const remoteAddr = info?.remoteAddr as Deno.NetAddr | undefined;
    handleConnection(socket, remoteAddr?.hostname ?? "unknown");
    return response;
  }

  if (url.pathname === "/api/ice-servers") {
    const config = await getIceServers();
    return new Response(JSON.stringify(config), {
      headers: { "content-type": "application/json" },
    });
  }

  const staticResponse = await handleStaticRequest(req);
  if (staticResponse) return staticResponse;

  return new Response("Not found", { status: 404 });
}

if (import.meta.main) {
  const port = Number(Deno.env.get("PORT") ?? "8000");
  Deno.serve({ port }, handler);
  console.log(`Server running on http://localhost:${port}`);
}
