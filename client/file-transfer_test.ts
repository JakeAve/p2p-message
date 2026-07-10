// client/file-transfer_test.ts
import { assert, assertEquals } from "@std/assert";
import {
  type ChunkSink,
  FileSendJob,
  SEND_HIGH_WATER_BYTES,
} from "./file-transfer.ts";
import { decryptFileChunk, generateMessageId } from "./crypto.ts";
import { CHUNK_BYTES, type Payload } from "../shared/wire.ts";
import { flushAsync } from "./test-fakes.ts";

function makeAesKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  ) as Promise<CryptoKey>;
}

class FakeSink implements ChunkSink {
  frames: ArrayBuffer[] = [];
  bufferedAmount = 0;
  private lowListeners = new Set<() => void>();

  sendBinary(data: ArrayBuffer): void {
    this.frames.push(data);
  }
  onBufferedAmountLow(listener: () => void): () => void {
    this.lowListeners.add(listener);
    return () => this.lowListeners.delete(listener);
  }
  fireBufferedAmountLow(): void {
    for (const l of [...this.lowListeners]) l();
  }
}

function makeJob(bytes: Uint8Array, key: CryptoKey, sink = new FakeSink()) {
  const controls: Payload[] = [];
  const progress: number[] = [];
  const job = new FileSendJob({
    id: generateMessageId(),
    key,
    bytes,
    name: "data.bin",
    mime: "application/octet-stream",
    sink,
    sendControl: (p) => {
      controls.push(p);
      return Promise.resolve();
    },
    onProgress: (done) => progress.push(done),
  });
  return { job, sink, controls, progress };
}

Deno.test("FileSendJob: offer, in-order chunks that decrypt back, done with hash, progress", async () => {
  const key = await makeAesKey();
  const bytes = crypto.getRandomValues(new Uint8Array(CHUNK_BYTES * 2 + 5));
  const { job, sink, controls, progress } = makeJob(bytes, key);
  assertEquals(await job.run(), true);

  assertEquals(controls.length, 2);
  const offer = controls[0];
  assert(offer.type === "file-offer");
  assertEquals(offer.id, job.id);
  assertEquals(offer.size, bytes.length);
  assertEquals(offer.chunkSize, CHUNK_BYTES);
  assertEquals(offer.chunkCount, 3);
  const done = controls[1];
  assert(done.type === "file-done");
  assertEquals(done.id, job.id);

  assertEquals(sink.frames.length, 3);
  const reassembled = new Uint8Array(bytes.length);
  let offset = 0;
  for (let seq = 0; seq < 3; seq++) {
    const out = await decryptFileChunk(key, sink.frames[seq]);
    assertEquals(out.transferId, job.id);
    assertEquals(out.seq, seq);
    reassembled.set(out.bytes, offset);
    offset += out.bytes.length;
  }
  assertEquals(reassembled, bytes);
  assertEquals(progress, [CHUNK_BYTES, CHUNK_BYTES * 2, bytes.length]);
});

Deno.test("FileSendJob: pauses at high water and resumes on the low event", async () => {
  const key = await makeAesKey();
  const bytes = new Uint8Array(CHUNK_BYTES * 2);
  const { job, sink } = makeJob(bytes, key);
  sink.bufferedAmount = SEND_HIGH_WATER_BYTES + 1;
  const running = job.run();
  await flushAsync();
  assertEquals(sink.frames.length, 0); // parked before the first chunk
  sink.bufferedAmount = 0;
  sink.fireBufferedAmountLow();
  assertEquals(await running, true);
  assertEquals(sink.frames.length, 2);
});

Deno.test("FileSendJob: stop() while parked ends the run without file-done", async () => {
  const key = await makeAesKey();
  const { job, sink, controls } = makeJob(new Uint8Array(CHUNK_BYTES), key);
  sink.bufferedAmount = SEND_HIGH_WATER_BYTES + 1;
  const running = job.run();
  await flushAsync();
  job.stop("cancelled");
  assertEquals(await running, false);
  assertEquals(job.stopReason, "cancelled");
  assertEquals(sink.frames.length, 0);
  assertEquals(controls.filter((c) => c.type === "file-done"), []);
});
