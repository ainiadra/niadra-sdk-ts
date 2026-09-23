import { NiadraValidationError } from "./errors.js";
import { MAX_MEDIA_BYTES } from "./types/events.js";
import type { Handle } from "./types/common.js";
import type { MediaUploadRequest } from "./types/events.js";

/** Arguments of `uploadMedia()`. */
export interface UploadParams {
  /** The file itself. It is read into memory once, to hash it and send it. */
  data: Uint8Array | ArrayBuffer | Blob;
  /** Such as `audio/wav` or `image/png`. Storage checks it against the signed URL. */
  content_type: string;
  /**
   * Whose file it is, whenever you know. It is then stored under that person, so erasing them
   * erases it, even if no event ever references it.
   */
  subject?: Handle;
}

/** A file handed to Niadra. Put `media_ref` and `media_sha256` in the event's `content`. */
export interface MediaUpload {
  media_ref: string;
  media_sha256: string;
  content_type: string;
  size_bytes: number;
  expires_at: string | null;
}

export interface PreparedUpload {
  bytes: Uint8Array<ArrayBuffer>;
  request: MediaUploadRequest;
}

/** Reads, checks and hashes the file, and builds the body of `POST /v1/media/uploads`. */
export async function prepareUpload(params: UploadParams): Promise<PreparedUpload> {
  if (!params.content_type || params.content_type.length > 256) {
    throw new NiadraValidationError("content_type must be 1 to 256 characters");
  }
  const bytes = await readBytes(params.data);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_MEDIA_BYTES) {
    throw new NiadraValidationError(`media must be 1 byte to ${MAX_MEDIA_BYTES} bytes`);
  }
  const request: MediaUploadRequest = {
    content_type: params.content_type,
    size_bytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
  };
  if (params.subject) request.subject = params.subject;
  return { bytes, request };
}

/**
 * The bytes go straight to storage, so the URL must be HTTPS unless the API itself is not:
 * only the local emulator is served over plain HTTP, and anywhere else a downgrade would send
 * the customer's media in the clear.
 */
export function checkUploadURL(url: string, baseURL: string): void {
  const protocol = new URL(url).protocol;
  if (protocol === "https:" || (protocol === "http:" && new URL(baseURL).protocol === "http:")) return;
  throw new NiadraValidationError("the upload URL is not HTTPS");
}

async function readBytes(data: Uint8Array | ArrayBuffer | Blob): Promise<Uint8Array<ArrayBuffer>> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) {
    // A view over a SharedArrayBuffer cannot be a fetch body; only that case pays for a copy.
    return isPlain(data) ? data : new Uint8Array(data);
  }
  return new Uint8Array(await data.arrayBuffer());
}

function isPlain(view: Uint8Array): view is Uint8Array<ArrayBuffer> {
  return view.buffer instanceof ArrayBuffer;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) throw new NiadraValidationError("uploadMedia() needs Web Crypto, which this runtime lacks");
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
