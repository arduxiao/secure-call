import nacl from 'tweetnacl'
import naclUtil from 'tweetnacl-util'

// Short Authentication String (SAS) — 4 emoji derived from the ECDH shared key.
// Both peers MUST see the same 4 emoji; comparing them out-of-band defeats a
// signalling-server MITM that swaps public keys.
//
// Entropy: 32 emoji × 4 positions = 32⁴ ≈ 10⁶ ≈ 20 bits.
// A MITM that wants to NOT be caught must produce the same SAS on both sides
// simultaneously; the chance of a random hit is ~1 in 1,048,576 per attempt.
// Domain-separated hash so the SAS value is bound to this specific use of the key.

export const SAS_EMOJI = [
  '🦊', '🐱', '🐶', '🐼', '🐯', '🦁', '🐻', '🐰',
  '🐸', '🐵', '🦄', '🐙', '🐢', '🐧', '🦉', '🐝',
  '🦋', '🌸', '🌻', '🌈', '🌙', '⭐', '🍎', '🍌',
  '🍓', '🍕', '🍔', '🎸', '⚽', '🚗', '✈️', '🚀',
] as const

const DOMAIN = 'secure-call/sas/v1'

export function computeSAS(sharedKey: Uint8Array): string[] {
  // SHA-512(sharedKey || domain) — first 4 bytes mapped into the 32-emoji alphabet.
  // 256 % 32 === 0 so the modulo is unbiased.
  const domain = naclUtil.decodeUTF8(DOMAIN)
  const buf = new Uint8Array(sharedKey.length + domain.length)
  buf.set(sharedKey)
  buf.set(domain, sharedKey.length)
  const hash = nacl.hash(buf)
  return Array.from(hash.slice(0, 4), (b) => SAS_EMOJI[b % SAS_EMOJI.length])
}
