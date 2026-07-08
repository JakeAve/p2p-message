export const WIRE_VERSION = 1;

export type PubkeyFrame = { v: 1; type: "pubkey"; key: string };
export type EncryptedFrame = { v: 1; type: "enc"; iv: string; ct: string };
export type Frame = PubkeyFrame | EncryptedFrame;

export type Payload =
  | { type: "key-confirm"; transcriptHash: string }
  | { type: "identity"; displayName: string }
  | { type: "chat"; id?: string; content: string }
  | { type: "delivered"; id: string }
  | { type: "typing"; active: boolean }
  | { type: "end" };

export type WireErrorCode = "bad-json" | "bad-version" | "bad-frame";

export class WireError extends Error {
  code: WireErrorCode;

  constructor(code: WireErrorCode) {
    super(`wire error: ${code}`);
    this.name = "WireError";
    this.code = code;
  }
}

export function parseFrame(raw: string): Frame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WireError("bad-json");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new WireError("bad-frame");
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.v !== "number") {
    throw new WireError("bad-frame");
  }
  if (obj.v !== WIRE_VERSION) {
    throw new WireError("bad-version");
  }
  if (obj.type === "pubkey" && typeof obj.key === "string") {
    return { v: 1, type: "pubkey", key: obj.key };
  }
  if (
    obj.type === "enc" &&
    typeof obj.iv === "string" &&
    typeof obj.ct === "string"
  ) {
    return { v: 1, type: "enc", iv: obj.iv, ct: obj.ct };
  }
  throw new WireError("bad-frame");
}
