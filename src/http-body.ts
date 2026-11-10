export class ResponseTooLargeError extends Error {
  constructor() {
    super("Response exceeds the configured byte limit");
    this.name = "ResponseTooLargeError";
  }
}

/** Enforce the byte limit while streaming, even without Content-Length. */
export async function readBoundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new ResponseTooLargeError();
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ResponseTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}
