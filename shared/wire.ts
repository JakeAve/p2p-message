export const WIRE_VERSION = 1;

export type PubkeyFrame = { v: 1; type: "pubkey"; key: string };
export type EncryptedFrame = { v: 1; type: "enc"; iv: string; ct: string };
export type Frame = PubkeyFrame | EncryptedFrame;

export type FileCancelReason = "sender" | "receiver" | "error";

export type FileOffer = {
  type: "file-offer";
  id: string;
  name: string;
  mime: string;
  size: number;
  chunkSize: number;
  chunkCount: number;
};

export type Payload =
  | { type: "key-confirm"; transcriptHash: string }
  | { type: "identity"; displayName: string }
  | { type: "chat"; id?: string; content: string }
  | { type: "delivered"; id: string }
  | { type: "typing"; active: boolean }
  | { type: "end" }
  | FileOffer
  | { type: "file-done"; id: string; sha256: string }
  | { type: "file-cancel"; id: string; reason: FileCancelReason }
  | { type: "file-received"; id: string };

/** File transfer framing (spec §1): binary chunks on the data channel. */
export const CHUNK_BYTES = 16_384; // 16 KB — universally safe DC message size
export const MAX_FILE_BYTES = 52_428_800; // 50 MB
export const MAX_FILE_NAME_CHARS = 255;
export const BINARY_FRAME_VERSION = 1;

export function chunkCountFor(size: number): number {
  return Math.ceil(size / CHUNK_BYTES);
}

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
