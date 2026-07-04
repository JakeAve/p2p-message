import { assert, assertEquals } from "@std/assert";

const THEME_IDS = ["default", "90s", "banana", "gram", "whosapp"];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readDimensions(
  bytes: Uint8Array,
): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

for (const id of THEME_IDS) {
  Deno.test(`client/og-images/${id}.png is a valid 1200x630 PNG`, async () => {
    const bytes = await Deno.readFile(
      new URL(`./og-images/${id}.png`, import.meta.url),
    );
    assertEquals(Array.from(bytes.slice(0, 8)), PNG_SIGNATURE);
    const { width, height } = readDimensions(bytes);
    assertEquals(width, 1200);
    assertEquals(height, 630);
    assert(
      bytes.byteLength > 1000,
      `suspiciously small: ${bytes.byteLength} bytes`,
    );
  });
}
