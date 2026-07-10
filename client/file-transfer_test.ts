// client/file-transfer_test.ts
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type ChunkSink,
  FileReceiveJob,
  FileSendJob,
  SEND_HIGH_WATER_BYTES,
  validateOffer,
} from "./file-transfer.ts";
import {
  decryptFileChunk,
  encryptFileChunk,
  generateMessageId,
  sha256Base64url,
} from "./crypto.ts";
import {
  CHUNK_BYTES,
  chunkCountFor,
  type FileOffer,
  MAX_FILE_BYTES,
  type Payload,
} from "../shared/wire.ts";
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

function offerFor(bytes: Uint8Array, id: string): FileOffer {
  return {
    type: "file-offer",
    id,
    name: "data.bin",
    mime: "application/octet-stream",
    size: bytes.length,
    chunkSize: CHUNK_BYTES,
    chunkCount: chunkCountFor(bytes.length),
  };
}

async function framesFor(
  bytes: Uint8Array,
  id: string,
  key: CryptoKey,
): Promise<ArrayBuffer[]> {
  const frames: ArrayBuffer[] = [];
  for (let seq = 0; seq < chunkCountFor(bytes.length); seq++) {
    const end = Math.min(bytes.length, (seq + 1) * CHUNK_BYTES);
    frames.push(
      await encryptFileChunk(
        key,
        id,
        seq,
        bytes.subarray(seq * CHUNK_BYTES, end),
      ),
    );
  }
  return frames;
}

Deno.test("validateOffer: accepts a sane offer, rejects each violation", () => {
  const good = offerFor(new Uint8Array(100), generateMessageId());
  assertEquals(validateOffer(good), null);
  assertEquals(validateOffer({ ...good, size: 0 }), "empty");
  assertEquals(
    validateOffer({ ...good, size: MAX_FILE_BYTES + 1 }),
    "too-large",
  );
  assertEquals(validateOffer({ ...good, name: "" }), "bad-name");
  assertEquals(validateOffer({ ...good, name: "x".repeat(256) }), "bad-name");
  assertEquals(validateOffer({ ...good, chunkSize: 1024 }), "bad-chunking");
  assertEquals(validateOffer({ ...good, chunkCount: 99 }), "bad-chunking");
});

Deno.test("FileReceiveJob: reassembles, verifies hash, builds the Blob", async () => {
  const key = await makeAesKey();
  const id = generateMessageId();
  const bytes = crypto.getRandomValues(new Uint8Array(CHUNK_BYTES + 7));
  const job = new FileReceiveJob(offerFor(bytes, id), key);
  const progress: number[] = [];
  for (const frame of await framesFor(bytes, id, key)) {
    const res = await job.acceptFrame(frame);
    assert(res.match);
    progress.push(res.bytesDone);
  }
  assertEquals(progress, [CHUNK_BYTES, bytes.length]);
  const blob = await job.finish(await sha256Base64url(bytes));
  assertEquals(new Uint8Array(await blob.arrayBuffer()), bytes);
  assertEquals(blob.type, "application/octet-stream");
});

Deno.test("FileReceiveJob: a chunk for another transfer id is a non-matching no-op", async () => {
  const key = await makeAesKey();
  const bytes = new Uint8Array(10);
  const job = new FileReceiveJob(offerFor(bytes, generateMessageId()), key);
  const stray = await encryptFileChunk(key, generateMessageId(), 0, bytes);
  assertEquals(await job.acceptFrame(stray), { match: false });
});

Deno.test("FileReceiveJob: out-of-order seq throws", async () => {
  const key = await makeAesKey();
  const id = generateMessageId();
  const bytes = new Uint8Array(CHUNK_BYTES * 2);
  const job = new FileReceiveJob(offerFor(bytes, id), key);
  const frames = await framesFor(bytes, id, key);
  await assertRejects(() => job.acceptFrame(frames[1])); // expected seq 0
});

Deno.test("FileReceiveJob: finish with a wrong hash throws; finish incomplete throws", async () => {
  const key = await makeAesKey();
  const id = generateMessageId();
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  const job = new FileReceiveJob(offerFor(bytes, id), key);
  await assertRejects(() =>
    job.finish("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
  );
  for (const frame of await framesFor(bytes, id, key)) {
    await job.acceptFrame(frame);
  }
  await assertRejects(() =>
    job.finish("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
  );
});
