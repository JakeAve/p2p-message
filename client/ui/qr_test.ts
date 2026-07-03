import { assert, assertEquals } from "@std/assert";
import { createQrSvg } from "./qr.ts";

const LINK = `https://example.com/r/${"A".repeat(22)}#${"B".repeat(43)}`;

Deno.test("createQrSvg returns a complete standalone SVG", () => {
  const svg = createQrSvg(LINK);
  assert(svg.trimStart().startsWith("<svg"));
  assert(svg.trimEnd().endsWith("</svg>"));
  assert(svg.includes("<path") || svg.includes("<rect")); // has actual modules
});

Deno.test("createQrSvg is deterministic and synchronous", () => {
  assertEquals(createQrSvg(LINK), createQrSvg(LINK));
});

Deno.test("different links produce different codes", () => {
  const other = `https://example.com/r/${"C".repeat(22)}#${"D".repeat(43)}`;
  assert(createQrSvg(LINK) !== createQrSvg(other));
});
