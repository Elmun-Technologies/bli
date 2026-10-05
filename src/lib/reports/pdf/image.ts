/**
 * Image sniffing for report branding and map artifacts.
 *
 * Format is decided by the bytes, never by the file extension or the declared
 * MIME type alone: a PNG/JPEG header must be present, and nothing else is
 * accepted. SVG (and every other scriptable or vector format) is deliberately
 * unsupported in Phase 7.
 */

export const REPORT_LOGO_MAX_BYTES = 2 * 1024 * 1024;

export type SniffedImageFormat = 'image/png' | 'image/jpeg';

export interface SniffedImage {
  format: SniffedImageFormat;
  /** Image dimensions when they can be read from the header. */
  width: number | null;
  height: number | null;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** Returns the real image format, or null when the bytes are not a PNG/JPEG. */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  if (bytes.byteLength < 4) return null;

  if (isPng(bytes)) {
    // IHDR follows the 8-byte signature: length(4) type(4) width(4) height(4)
    if (bytes.byteLength >= 24 && bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return { format: 'image/png', width: view.getUint32(16), height: view.getUint32(20) };
    }
    return { format: 'image/png', width: null, height: null };
  }

  if (isJpeg(bytes)) {
    return { format: 'image/jpeg', width: null, height: null };
  }

  return null;
}

/** True when the bytes are an acceptable report logo. */
export function isAcceptableLogo(bytes: Uint8Array): boolean {
  return bytes.byteLength > 0 && bytes.byteLength <= REPORT_LOGO_MAX_BYTES && sniffImage(bytes) !== null;
}

/** The `{ data, format }` shape @react-pdf/renderer embeds, or null when unusable. */
export function toDocumentImage(
  bytes: Uint8Array | null,
): { data: Buffer; format: 'png' | 'jpg' } | null {
  if (!bytes || bytes.byteLength === 0) return null;
  const sniffed = sniffImage(bytes);
  if (!sniffed) return null;
  return { data: Buffer.from(bytes), format: sniffed.format === 'image/jpeg' ? 'jpg' : 'png' };
}
