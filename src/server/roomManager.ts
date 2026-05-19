export interface Room {
  symbols?: string      // A 的暗语
  symbolsB?: string     // B 的暗语（join-room 时由 B 提交）
  pubKeyA?: string
  pubKeyB?: string
  socketA: string
  socketB?: string
  expiresAt: number
  state: 'waiting' | 'connecting' | 'active'
}

const rooms = new Map<string, Room>()

setInterval(() => {
  const now = Date.now()
  rooms.forEach((room, id) => {
    if (room.expiresAt < now) rooms.delete(id)
  })
}, 60_000)

export { rooms }
