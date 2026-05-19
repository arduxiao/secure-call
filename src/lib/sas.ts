import nacl from 'tweetnacl'
import naclUtil from 'tweetnacl-util'

// Short Authentication String (SAS) — 6 emoji derived from the ECDH shared key.
// Both peers MUST see the same 6 emoji; comparing them out-of-band defeats a
// signalling-server MITM that swaps public keys.
//
// Entropy: 32 emoji × 6 positions = 32⁶ ≈ 1.07 × 10⁹ ≈ 30 bits.
// Old length (4 emoji = 20 bits ≈ 10⁶) was attackable in ~30 s on a laptop
// because the server IS the attacker in our threat model — they can offline-
// grind both sides' keypairs until ECDH(s_att, pubA) and ECDH(s_att', pubB)
// collide to the same SAS prefix. 30 bits pushes that grind to ~10⁹ ops
// ≈ hours on a single GPU, ~minutes on a small cluster. Still not strong
// against state-level adversaries (those want ≥ 60 bits), but enough to
// raise the bar past trivial scripts.
// 256 % 32 === 0 so byte → emoji mapping is unbiased.
// Domain-separated hash so the SAS value is bound to this specific use of the key.

export const SAS_EMOJI = [
  '🦊', '🐱', '🐶', '🐼', '🐯', '🦁', '🐻', '🐰',
  '🐸', '🐵', '🦄', '🐙', '🐢', '🐧', '🦉', '🐝',
  '🦋', '🌸', '🌻', '🌈', '🌙', '⭐', '🍎', '🍌',
  '🍓', '🍕', '🍔', '🎸', '⚽', '🚗', '✈️', '🚀',
] as const

// Versioned so future entropy bumps don't silently break compatibility — peers
// running mismatched protocol versions would derive different SAS values and
// the human verification step would catch it as a "MITM" reject.
const DOMAIN = 'secure-call/sas/v2'
export const SAS_LENGTH = 6

export function computeSAS(sharedKey: Uint8Array): string[] {
  const domain = naclUtil.decodeUTF8(DOMAIN)
  const buf = new Uint8Array(sharedKey.length + domain.length)
  buf.set(sharedKey)
  buf.set(domain, sharedKey.length)
  const hash = nacl.hash(buf)
  return Array.from(hash.slice(0, SAS_LENGTH), (b) => SAS_EMOJI[b % SAS_EMOJI.length])
}
