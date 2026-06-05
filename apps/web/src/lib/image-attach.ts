import { MAX_IMAGE_BASE64_BYTES, type ImageAttachment } from '@steer/schema'

/**
 * Client-side image-attach helpers for the task composer (R14, vision input).
 *
 * The composer lets the operator attach a screenshot / error / design mock to the
 * initial task. The image is read into a base64 `ImageAttachment` here, validated
 * for an `image/*` MIME type and the same size cap the server enforces (so the
 * operator gets immediate feedback instead of a round-trip 400), and previewed as
 * a data URL. The server write boundary re-validates — this is convenience, not a
 * trust boundary.
 */

/** Outcome of reading a chosen file: a validated attachment, or a clear error. */
export type ReadImageResult =
  | { ok: true; image: ImageAttachment }
  | { ok: false; error: string }

/** A `FileReader`-like seam so the reader is testable without a real DOM File. */
export interface ReadableFile {
  type: string
  /** Resolve to a `data:<mediaType>;base64,<bytes>` URL (what `FileReader.readAsDataURL` yields). */
  toDataUrl(): Promise<string>
}

/** Split a `data:<mediaType>;base64,<bytes>` URL into its parts, or null if malformed. */
export function parseDataUrl(dataUrl: string): { mediaType: string; dataBase64: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl)
  if (!match) return null
  const mediaType = match[1]!
  const dataBase64 = match[2]!
  if (dataBase64.length === 0) return null
  return { mediaType, dataBase64 }
}

/** Assemble the preview `data:` URL for a validated attachment. */
export function toPreviewUrl(image: ImageAttachment): string {
  return `data:${image.mediaType};base64,${image.dataBase64}`
}

/**
 * Read a chosen file into a validated `ImageAttachment`. Rejects a non-image MIME
 * type and an over-cap payload with a human-readable message the composer surfaces;
 * never throws on bad input. The base64 byte length is measured against the shared
 * cap so client and server agree on the boundary.
 */
export async function readImageFile(file: ReadableFile): Promise<ReadImageResult> {
  if (!file.type.startsWith('image/')) {
    return { ok: false, error: 'Only image files can be attached.' }
  }
  let dataUrl: string
  try {
    dataUrl = await file.toDataUrl()
  } catch {
    return { ok: false, error: 'Could not read the image file.' }
  }
  const parsed = parseDataUrl(dataUrl)
  if (!parsed) {
    return { ok: false, error: 'Could not read the image file.' }
  }
  if (parsed.dataBase64.length > MAX_IMAGE_BASE64_BYTES) {
    return {
      ok: false,
      error: `Image is too large (max ${Math.floor(MAX_IMAGE_BASE64_BYTES / 1000)} KB encoded).`,
    }
  }
  return { ok: true, image: { mediaType: parsed.mediaType, dataBase64: parsed.dataBase64 } }
}

/** Adapt a browser `File` to a `ReadableFile` using `FileReader.readAsDataURL`. */
export function fromBrowserFile(file: File): ReadableFile {
  return {
    type: file.type,
    toDataUrl: () =>
      new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result ?? ''))
        reader.onerror = () => reject(new Error('read failed'))
        reader.readAsDataURL(file)
      }),
  }
}
