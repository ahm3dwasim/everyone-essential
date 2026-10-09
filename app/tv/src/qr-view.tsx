/** The QR code as an SVG, sized in CSS pixels. */
import { qrMatrix, qrPath } from "./qr.tsx";

export function QrView({ text, size }: { text: string; size: number }) {
  let path = "";
  let modules = 0;
  try {
    const matrix = qrMatrix(text);
    path = qrPath(matrix);
    modules = matrix.size;
  } catch {
    // A URL too long for any version: show nothing rather than a wrong code.
    return <div class="qr qr-failed" style={{ width: `${size}px`, height: `${size}px` }} />;
  }
  return (
    <svg
      class="qr"
      width={size}
      height={size}
      viewBox={`-1 -1 ${modules + 2} ${modules + 2}`}
      role="img"
      aria-label={`QR code for ${text}`}
    >
      <rect x={-1} y={-1} width={modules + 2} height={modules + 2} fill="#ffffff" />
      <path d={path} fill="#0b0b0d" />
    </svg>
  );
}
