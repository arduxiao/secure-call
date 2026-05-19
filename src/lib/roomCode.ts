// Crockford-ish base32: no I/L/O/0/1 (visually ambiguous when read aloud or hand-written).
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const ROOM_CODE_LEN = 8
// Built once for cheap validation; sticks to the alphabet above.
export const ROOM_CODE_RE = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LEN}}$`)

export function generateRoomCode(): string {
  let code = ''
  const array = new Uint8Array(ROOM_CODE_LEN)
  crypto.getRandomValues(array)
  for (let i = 0; i < ROOM_CODE_LEN; i++) {
    code += ROOM_CODE_ALPHABET[array[i] % ROOM_CODE_ALPHABET.length]
  }
  return code
}

export function isValidRoomCode(s: string): boolean {
  return ROOM_CODE_RE.test(s)
}
