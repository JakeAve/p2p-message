/** One selectable timer option (spec §5 presets, pinned in overview C6). */
export interface Preset {
  label: string;
  ms: number;
}

export const INVITE_PRESETS: Preset[] = [
  { label: "2 min", ms: 120_000 },
  { label: "10 min", ms: 600_000 },
  { label: "30 min", ms: 1_800_000 },
  { label: "1 hour", ms: 3_600_000 },
];
export const DEFAULT_INVITE_MS = 600_000;

export const GRACE_PRESETS: Preset[] = [
  { label: "30 sec", ms: 30_000 },
  { label: "2 min", ms: 120_000 },
  { label: "10 min", ms: 600_000 },
  { label: "30 min", ms: 1_800_000 },
];
export const DEFAULT_GRACE_MS = 120_000;
