import { assert, assertEquals } from "@std/assert";
import {
  DEFAULT_GRACE_MS,
  DEFAULT_INVITE_MS,
  GRACE_PRESETS,
  INVITE_PRESETS,
} from "./presets.ts";

Deno.test("invite presets are 2/10/30/60 minutes, default 10", () => {
  assertEquals(
    INVITE_PRESETS.map((p) => p.ms),
    [120_000, 600_000, 1_800_000, 3_600_000],
  );
  assertEquals(DEFAULT_INVITE_MS, 600_000);
  assert(INVITE_PRESETS.some((p) => p.ms === DEFAULT_INVITE_MS));
});

Deno.test("grace presets are 30s/2/10/30 minutes, default 2 min", () => {
  assertEquals(
    GRACE_PRESETS.map((p) => p.ms),
    [30_000, 120_000, 600_000, 1_800_000],
  );
  assertEquals(DEFAULT_GRACE_MS, 120_000);
  assert(GRACE_PRESETS.some((p) => p.ms === DEFAULT_GRACE_MS));
});

Deno.test("every preset has a human label", () => {
  for (const p of [...INVITE_PRESETS, ...GRACE_PRESETS]) {
    assert(p.label.length > 0);
  }
});
