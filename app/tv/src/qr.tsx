/**
 * The QR code a phone scans to join.
 *
 * Generated in the browser from the phone URL -- no service, no network, which
 * matters because the whole point is a LAN with no internet in the room. The
 * encoder is `qrcode-generator` (MIT, ~10 kB); rendering it as one SVG path
 * keeps it sharp on a 1080p screen and cheap for a Fire Stick to draw.
 */
import qrcode from "qrcode-generator";

export interface QrMatrix {
  size: number;
  /** Row-major: true where a module is dark. */
  dark: boolean[][];
}

export function qrMatrix(text: string): QrMatrix {
  // Type 0 = smallest version that fits, level M = the usual size/redundancy
  // trade-off for a URL read across a room.
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  const dark: boolean[][] = [];
  for (let row = 0; row < size; row++) {
    const line: boolean[] = [];
    for (let column = 0; column < size; column++) line.push(qr.isDark(row, column));
    dark.push(line);
  }
  return { size, dark };
}

/** One path for the whole code: a rect per run of dark modules in a row. */
export function qrPath(matrix: QrMatrix): string {
  const parts: string[] = [];
  for (let row = 0; row < matrix.size; row++) {
    let runStart = -1;
    for (let column = 0; column <= matrix.size; column++) {
      const isDark = column < matrix.size && matrix.dark[row]?.[column] === true;
      if (isDark && runStart < 0) runStart = column;
      if (!isDark && runStart >= 0) {
        parts.push(`M${runStart} ${row}h${column - runStart}v1h-${column - runStart}z`);
        runStart = -1;
      }
    }
  }
  return parts.join("");
}
