/**
 * SHA-256 (FIPS 180-4), synchronous, for what hashes in the middle of a computation (niadra-expr's
 * `sha256()`, the exposure token's verifier). Web Crypto only hashes asynchronously, and the SDK runs on Node, Deno, Bun, Workers and edge
 * runtimes alike, so this is plain 32-bit arithmetic with no runtime module.
 */

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
];
const INITIAL = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** The SHA-256 of `bytes`, in lowercase hexadecimal. */
export function sha256Hex(bytes: Uint8Array): string {
  return Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The SHA-256 of `bytes`. */
export function sha256(bytes: Uint8Array): Uint8Array {
  // The message, a 1 bit, zeros, and its length in bits as a 64-bit big-endian number, in blocks of 64 bytes.
  const size = Math.ceil((bytes.length + 9) / 64) * 64;
  const message = new Uint8Array(size);
  message.set(bytes);
  message[bytes.length] = 0x80;
  const blocks = new DataView(message.buffer);
  blocks.setUint32(size - 8, Math.floor(bytes.length / 0x20000000));
  blocks.setUint32(size - 4, bytes.length * 8);

  // DataView reads and writes big-endian words, and setUint32 keeps a sum modulo 2^32.
  const state = new DataView(new ArrayBuffer(32));
  INITIAL.forEach((word, i) => {
    state.setUint32(i * 4, word);
  });
  const w = new DataView(new ArrayBuffer(256));
  for (let offset = 0; offset < size; offset += 64) {
    for (let t = 0; t < 16; t++) w.setUint32(t * 4, blocks.getUint32(offset + t * 4));
    for (let t = 16; t < 64; t++) {
      const x = w.getUint32((t - 15) * 4);
      const y = w.getUint32((t - 2) * 4);
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w.setUint32(t * 4, w.getUint32((t - 16) * 4) + s0 + w.getUint32((t - 7) * 4) + s1);
    }
    let [a, b, c, d] = [state.getUint32(0), state.getUint32(4), state.getUint32(8), state.getUint32(12)];
    let [e, f, g, h] = [state.getUint32(16), state.getUint32(20), state.getUint32(24), state.getUint32(28)];
    for (const [t, k] of K.entries()) {
      const t1 = h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + k + w.getUint32(t * 4);
      const t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((word, i) => {
      state.setUint32(i * 4, state.getUint32(i * 4) + word);
    });
  }
  return new Uint8Array(state.buffer);
}
