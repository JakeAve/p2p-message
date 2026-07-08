/** Spec §7.2: message text is capped at 4,000 UTF-8 bytes. */
export const MAX_MESSAGE_BYTES = 4000;

const encoder = new TextEncoder();

/** Byte length of `text` in UTF-8 (multibyte-aware; NOT `.length`). */
export function utf8ByteLength(text: string): number {
  return encoder.encode(text).length;
}

/**
 * Render a remaining duration as "m:ss" (or "h:mm:ss" at an hour or more).
 * Rounds up to the next whole second and clamps negatives to "0:00".
 */
export function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Short local time for the tap-to-reveal line (e.g. "3:42 PM" / "15:42").
 * `locale` is a test seam; production callers omit it for the user's locale.
 */
export function formatMessageTime(timestamp: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}
