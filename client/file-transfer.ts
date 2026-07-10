// client/file-transfer.ts
// Pure file-transfer logic (spec §3): chunking/pacing on the send side,
// validation/reassembly on the receive side. No session or DOM knowledge;
// session.ts owns wiring these to the transport and its event stream.
import { CHUNK_BYTES, chunkCountFor, type Payload } from "../shared/wire.ts";
import { encryptFileChunk, sha256Base64url } from "./crypto.ts";

export type FileFailReason = "cancelled" | "error" | "disconnected";

/** What a send job needs from the transport (Transport satisfies this). */
export interface ChunkSink {
  sendBinary(data: ArrayBuffer): void;
  readonly bufferedAmount: number;
  onBufferedAmountLow(listener: () => void): () => void;
}

/** Sender pauses above this many buffered bytes (spec §2). */
export const SEND_HIGH_WATER_BYTES = 1_048_576; // 1 MB

export interface FileSendOptions {
  id: string;
  key: CryptoKey;
  bytes: Uint8Array;
  name: string;
  mime: string;
  sink: ChunkSink;
  /** Encrypts and sends a JSON control payload (offer/done). */
  sendControl: (p: Payload) => Promise<void>;
  onProgress: (bytesDone: number, bytesTotal: number) => void;
  highWater?: number;
}

export class FileSendJob {
  readonly id: string;
  private readonly opts: FileSendOptions;
  private stopped: FileFailReason | null = null;
  private drainResolve: (() => void) | null = null;
  private drainUnsub: (() => void) | null = null;

  constructor(opts: FileSendOptions) {
    this.opts = opts;
    this.id = opts.id;
  }

  get stopReason(): FileFailReason | null {
    return this.stopped;
  }

  /** Resolves true when file-done was sent, false when stopped early. */
  async run(): Promise<boolean> {
    const { bytes, key, sink, name, mime } = this.opts;
    const highWater = this.opts.highWater ?? SEND_HIGH_WATER_BYTES;
    const total = bytes.length;
    const count = chunkCountFor(total);
    const sha256 = await sha256Base64url(bytes as Uint8Array<ArrayBuffer>);
    if (this.stopped) return false;
    await this.opts.sendControl({
      type: "file-offer",
      id: this.id,
      name,
      mime,
      size: total,
      chunkSize: CHUNK_BYTES,
      chunkCount: count,
    });
    for (let seq = 0; seq < count; seq++) {
      if (this.stopped) return false;
      if (sink.bufferedAmount > highWater) await this.waitForDrain();
      if (this.stopped) return false;
      const end = Math.min(total, (seq + 1) * CHUNK_BYTES);
      const frame = await encryptFileChunk(
        key,
        this.id,
        seq,
        bytes.subarray(seq * CHUNK_BYTES, end),
      );
      if (this.stopped) return false;
      sink.sendBinary(frame);
      this.opts.onProgress(end, total);
    }
    if (this.stopped) return false;
    await this.opts.sendControl({ type: "file-done", id: this.id, sha256 });
    return true;
  }

  /** Local cancel, remote file-cancel, or disconnect: ends the loop. */
  stop(reason: FileFailReason): void {
    if (this.stopped !== null) return;
    this.stopped = reason;
    this.releaseDrain();
  }

  private waitForDrain(): Promise<void> {
    return new Promise((resolve) => {
      this.drainResolve = resolve;
      this.drainUnsub = this.opts.sink.onBufferedAmountLow(() =>
        this.releaseDrain()
      );
    });
  }

  private releaseDrain(): void {
    this.drainUnsub?.();
    this.drainUnsub = null;
    const resolve = this.drainResolve;
    this.drainResolve = null;
    resolve?.();
  }
}
