export function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  const array = new Uint8Array(8)
  crypto.getRandomValues(array)
  for (let i = 0; i < 8; i++) {
    code += chars[array[i] % chars.length]
  }
  return code
}
