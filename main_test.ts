import { assertEquals } from "@std/assert";

async function startMain(): Promise<{
  child: Deno.ChildProcess;
  port: number;
  stdout: ReadableStreamDefaultReader<Uint8Array>;
}> {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "main.ts"],
    env: {
      PORT: "0", // OS-assigned; main.ts logs the real port
      ICE_STUN_SERVERS: "stun:stun.example.com:19302",
    },
    stdout: "piped",
    stderr: "inherit",
  }).spawn();

  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value);
    const match = buffer.match(/listening on port (\d+)/);
    if (match) return { child, port: Number(match[1]), stdout: reader };
  }
  child.kill("SIGINT");
  await child.status;
  throw new Error(`server never reported its port; output: ${buffer}`);
}

Deno.test("main.ts: /ws without upgrade → 400; /api/ice-servers → JSON; /ws upgrade works", async () => {
  const { child, port, stdout } = await startMain();
  try {
    // Non-upgrade GET /ws → 400
    const res = await fetch(`http://127.0.0.1:${port}/ws`);
    assertEquals(res.status, 400);
    await res.body?.cancel();

    // ICE config route
    const ice = await fetch(`http://127.0.0.1:${port}/api/ice-servers`);
    assertEquals(ice.status, 200);
    assertEquals(ice.headers.get("content-type"), "application/json");
    const body = await ice.json();
    assertEquals(body, {
      iceServers: [{ urls: ["stun:stun.example.com:19302"] }],
    });

    // Real upgrade reaches the signaling handler (ping → pong)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const pong = await new Promise<unknown>((resolve, reject) => {
      ws.addEventListener(
        "open",
        () => ws.send(JSON.stringify({ type: "ping" })),
      );
      ws.addEventListener(
        "message",
        (e) => resolve(JSON.parse(e.data as string)),
        { once: true },
      );
      ws.addEventListener("error", () => reject(new Error("ws error")), {
        once: true,
      });
    });
    assertEquals(pong, { type: "pong" });
    ws.close();
    await new Promise((resolve) =>
      ws.addEventListener("close", resolve, { once: true })
    );
  } finally {
    child.kill("SIGINT");
    await child.status;
    stdout.releaseLock();
    await child.stdout.cancel();
  }
});
