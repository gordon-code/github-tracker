// Cloudflare Workers non-standard SubtleCrypto extensions.
// See https://developers.cloudflare.com/workers/runtime-apis/web-crypto/

interface SubtleCrypto {
  /**
   * Compares two buffers in constant time, preventing timing attacks.
   *
   * Both buffers MUST have the same byte length — hash both inputs with
   * SHA-256 first so lengths are always equal. See the Cloudflare Workers
   * timing-attack protection example for the recommended pattern.
   *
   * @throws {TypeError} if a.byteLength !== b.byteLength
   * @see https://developers.cloudflare.com/workers/examples/protect-against-timing-attacks/
   */
  timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
}
