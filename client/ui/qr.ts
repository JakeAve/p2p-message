import qrcode from "qrcode-generator";

/**
 * Render `text` as a QR code SVG string, synchronously and fully
 * client-side (the share link embeds the fragment secret — it must never
 * be sent to a third-party QR service). Type number 0 = auto-size,
 * error correction M.
 */
export function createQrSvg(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag(4, 4); // cellSize 4, margin 4 modules
}
