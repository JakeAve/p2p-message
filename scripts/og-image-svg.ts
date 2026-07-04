/// Pure SVG string builder for the 5 per-theme OG share-preview images.
/// No network, no wasm — rasterization happens in generate-og-images.ts.

export const WIDTH = 1200;
export const HEIGHT = 630;
export const MESSAGE = "You have been invited to a secure chat";
export const MESSAGE_LINES = ["You have been", "invited to a", "secure chat"];
if (MESSAGE_LINES.join(" ") !== MESSAGE) {
  throw new Error(
    "MESSAGE_LINES must join back into MESSAGE — keep them in sync",
  );
}
const FONT_FAMILY = "DejaVu Sans";
const FONT_SIZE = 108;
const LINE_HEIGHT = 128;

export interface Theme {
  id: string;
  textColor: string;
  /** Raw SVG markup (defs + background shapes) inserted right after <svg>. */
  background: string;
  /** Test-only override of the rendered message; production callers omit this. */
  text?: string;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const WHOSAPP_DOODLE_DEFS =
  `<pattern id="whosappDoodle" width="90" height="90" patternUnits="userSpaceOnUse">
      <circle cx="15" cy="20" r="6" fill="none" stroke="#d8cfc3" stroke-width="2" />
      <path d="M45 10 Q55 25 45 40 Q35 25 45 10 Z" fill="none" stroke="#d8cfc3" stroke-width="2" />
      <circle cx="70" cy="65" r="8" fill="none" stroke="#d8cfc3" stroke-width="2" />
      <path d="M10 70 Q20 60 30 70 Q20 80 10 70 Z" fill="none" stroke="#d8cfc3" stroke-width="2" />
    </pattern>`;

export const THEMES: Theme[] = [
  {
    id: "default",
    textColor: "#0e7490",
    background: `<rect width="${WIDTH}" height="${HEIGHT}" fill="#eef1f5" />`,
  },
  {
    id: "90s",
    textColor: "#ffffff",
    background: `<rect width="${WIDTH}" height="${HEIGHT}" fill="#008080" />`,
  },
  {
    id: "banana",
    textColor: "#007aff",
    background: `<rect width="${WIDTH}" height="${HEIGHT}" fill="#f2f2f7" />`,
  },
  {
    id: "gram",
    textColor: "#ffffff",
    background: `<defs>
      <linearGradient id="gramGradient" x1="0%" y1="100%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#4f5bd5" />
        <stop offset="45%" stop-color="#962fbf" />
        <stop offset="75%" stop-color="#d62976" />
        <stop offset="100%" stop-color="#fa7e1e" />
      </linearGradient>
    </defs>
    <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#gramGradient)" />`,
  },
  {
    id: "whosapp",
    textColor: "#008069",
    background: `<defs>${WHOSAPP_DOODLE_DEFS}</defs>
    <rect width="${WIDTH}" height="${HEIGHT}" fill="#ece5dd" />
    <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#whosappDoodle)" />`,
  },
];

export function buildOgSvg(theme: Theme): string {
  const lines = theme.text !== undefined ? [theme.text] : MESSAGE_LINES;
  const blockHeight = (lines.length - 1) * LINE_HEIGHT;
  const startY = HEIGHT / 2 - blockHeight / 2 + FONT_SIZE * 0.35;
  const tspans = lines
    .map((line, i) =>
      `<tspan x="${WIDTH / 2}" y="${startY + i * LINE_HEIGHT}">${
        escapeXml(line)
      }</tspan>`
    )
    .join("");
  return `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  ${theme.background}
  <text text-anchor="middle" font-family="${FONT_FAMILY}" font-weight="700" font-size="${FONT_SIZE}" fill="${theme.textColor}">${tspans}</text>
</svg>`;
}
