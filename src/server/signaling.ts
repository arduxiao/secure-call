import { Server, Socket } from 'socket.io'
import { rooms, Room } from './roomManager'
// Wire-shape types live in src/lib/protocol.ts; server handlers validate at the
// boundary with isStr() guards instead of trusting the structural types directly.

// ─────────────────────────────────────────────────────────────────────────────
// Hard limits — defend against malicious clients flooding the memory map and
// relaying mega-payloads through the signalling server. Tuned so a legitimate
// audio+video SDP and ICE candidate fit comfortably, then 4× margin.
// ─────────────────────────────────────────────────────────────────────────────
const ROOMID_LEN = 8
const MAX_SYMBOLS_LEN = 64            // emoji string A picks; 4 emojis × ~10 bytes each ≈ 40
const PUBKEY_B64_LEN = 44             // X25519 pubkey is 32 bytes → 44 char base64 with '='
const MAX_SDP_LEN = 64 * 1024         // 64 KB encrypted SDP (full audio+video SDP is ~3-5KB plaintext)
const MAX_ICE_LEN = 4 * 1024          // 4 KB encrypted ICE candidate
const MAX_RELAY_TOTAL_BYTES = MAX_SDP_LEN * 4  // hard ceiling across one call

// Crockford-ish base32 — must mirror src/lib/roomCode.ts ROOM_CODE_ALPHABET.
const ROOMID_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/
const PUBKEY_RE = /^[A-Za-z0-9+/]{43}=$/        // 32-byte base64 always ends in single '='
const SYMBOL_RE = /^[\p{Any}]{1,64}$/u          // accept any printable unicode; length-capped

// ─────────────────────────────────────────────────────────────────────────────
// Per-socket rate limits — token bucket per event family. Numbers picked so a
// legitimate user has plenty of headroom (lookup retry, ICE trickle) but a
// flooder gets disconnected fast.
// ─────────────────────────────────────────────────────────────────────────────
interface Bucket { tokens: number; lastRefill: number; capacity: number; refillPerSec: number }

const LIMITS = {
  create:   { capacity: 5,    refillPerSec: 1 / 30 },   // ≤ 5 burst, ~1 per 30s sustained
  lookup:   { capacity: 20,   refillPerSec: 1 },        // ≤ 20 burst, ~1/sec sustained
  join:     { capacity: 5,    refillPerSec: 1 / 10 },
  relay:    { capacity: 200,  refillPerSec: 50 },       // ICE trickle can be busy
  verify:   { capacity: 5,    refillPerSec: 1 / 5 },
  hangup:   { capacity: 10,   refillPerSec: 1 / 5 },
} as const
type LimitKey = keyof typeof LIMITS

function makeBuckets(): Record<LimitKey, Bucket> {
  return Object.fromEntries(
    Object.entries(LIMITS).map(([k, cfg]) => [k, { tokens: cfg.capacity, lastRefill: Date.now(), capacity: cfg.capacity, refillPerSec: cfg.refillPerSec }]),
  ) as Record<LimitKey, Bucket>
}

function spend(b: Bucket): boolean {
  const now = Date.now()
  b.tokens = Math.min(b.capacity, b.tokens + ((now - b.lastRefill) / 1000) * b.refillPerSec)
  b.lastRefill = now
  if (b.tokens < 1) return false
  b.tokens -= 1
  return true
}

interface SocketState { buckets: Record<LimitKey, Bucket>; relayBytes: number }
const socketState = new WeakMap<Socket, SocketState>()

function stateFor(socket: Socket): SocketState {
  let s = socketState.get(socket)
  if (!s) { s = { buckets: makeBuckets(), relayBytes: 0 }; socketState.set(socket, s) }
  return s
}

function gate(socket: Socket, key: LimitKey): boolean {
  if (!spend(stateFor(socket).buckets[key])) {
    socket.emit('rate-limited', { event: key })
    return false
  }
  return true
}

// ─────────────────────────────────────────────────────────────────────────────

function isStr(v: unknown, max: number, re?: RegExp): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max && (!re || re.test(v))
}

export function registerSignalingHandlers(io: Server) {
  io.on('connection', (socket: Socket) => {
    // ---- [1] A creates room ----
    socket.on('create-room', (payload: unknown) => {
      try {
        if (!gate(socket, 'create')) return
        const { roomId, symbols, pubKeyA } = (payload || {}) as Record<string, unknown>
        if (!isStr(roomId, ROOMID_LEN, ROOMID_RE)) return socket.emit('error', { message: 'bad-room-id' })
        if (!isStr(symbols, MAX_SYMBOLS_LEN, SYMBOL_RE)) return socket.emit('error', { message: 'bad-symbols' })
        if (!isStr(pubKeyA, PUBKEY_B64_LEN, PUBKEY_RE)) return socket.emit('error', { message: 'bad-pubkey' })

        if (rooms.has(roomId)) {
          socket.emit('error', { message: 'room-exists' })
          return
        }
        const room: Room = {
          symbols,
          pubKeyA,
          socketA: socket.id,
          expiresAt: Date.now() + 15 * 60 * 1000,
          state: 'waiting',
        }
        rooms.set(roomId, room)
        socket.join(roomId)
        socket.emit('room-created', { roomId })
        console.log(`[signaling] room created: ${roomId} (total: ${rooms.size})`)
      } catch (e) {
        console.error('[signaling] create-room handler error', e)
      }
    })

    // ---- [2] B looks up room ----
    socket.on('lookup-room', (payload: unknown) => {
      try {
        if (!gate(socket, 'lookup')) return
        const { roomId } = (payload || {}) as Record<string, unknown>
        if (!isStr(roomId, ROOMID_LEN, ROOMID_RE)) return socket.emit('room-not-found')

        const room = rooms.get(roomId)
        if (!room || room.expiresAt < Date.now()) {
          rooms.delete(roomId)
          socket.emit('room-not-found')
          return
        }
        if (room.state !== 'waiting') {
          socket.emit('room-not-found')
          return
        }
        socket.emit('room-info', { symbols: room.symbols, pubKeyA: room.pubKeyA })
      } catch (e) {
        console.error('[signaling] lookup-room handler error', e)
      }
    })

    // ---- [3] B accepts, completes ECDH key exchange ----
    socket.on('join-room', (payload: unknown) => {
      try {
        if (!gate(socket, 'join')) return
        const { roomId, pubKeyB, callMode, symbolsB } = (payload || {}) as Record<string, unknown>
        if (!isStr(roomId, ROOMID_LEN, ROOMID_RE)) return socket.emit('room-not-found')
        if (!isStr(pubKeyB, PUBKEY_B64_LEN, PUBKEY_RE)) return socket.emit('error', { message: 'bad-pubkey' })
        if (!isStr(symbolsB, MAX_SYMBOLS_LEN, SYMBOL_RE)) return socket.emit('error', { message: 'bad-symbols' })
        const mode = callMode === 'video' ? 'video' : 'audio'

        const room = rooms.get(roomId)
        if (!room || room.state !== 'waiting') {
          socket.emit('room-not-found')
          return
        }
        room.pubKeyB = pubKeyB
        room.symbolsB = symbolsB
        room.socketB = socket.id
        room.state = 'connecting'
        socket.join(roomId)

        io.to(room.socketA).emit('peer-joined', { pubKeyB, callMode: mode, symbolsB })
      } catch (e) {
        console.error('[signaling] join-room handler error', e)
      }
    })

    // ---- [4] Relay encrypted WebRTC Offer / Answer / ICE ----
    const relayHelper = (
      key: LimitKey,
      payloadKey: 'sdp' | 'candidate',
      maxLen: number,
      forwardEvent: 'offer' | 'answer' | 'ice-candidate',
    ) =>
      (payload: unknown) => {
        try {
          if (!gate(socket, key)) return
          const obj = (payload || {}) as Record<string, unknown>
          const roomId = obj.roomId
          const blob = obj[payloadKey]
          const fromA = obj.fromA
          if (!isStr(roomId, ROOMID_LEN, ROOMID_RE)) return
          if (typeof blob !== 'string' || blob.length === 0 || blob.length > maxLen) return

          const st = stateFor(socket)
          st.relayBytes += blob.length
          if (st.relayBytes > MAX_RELAY_TOTAL_BYTES) {
            console.warn(`[signaling] relay-cap hit, disconnect ${socket.id}`)
            return socket.disconnect(true)
          }

          const room = rooms.get(roomId)
          if (!room) return
          // Only the room's participants may relay through it.
          if (room.socketA !== socket.id && room.socketB !== socket.id) return

          let target: string | undefined
          if (forwardEvent === 'offer') target = room.socketB
          else if (forwardEvent === 'answer') target = room.socketA
          else target = fromA ? room.socketB : room.socketA
          if (target) io.to(target).emit(forwardEvent, { [payloadKey]: blob } as Record<string, string>)
        } catch (e) {
          console.error(`[signaling] relay handler error`, e)
        }
      }

    socket.on('relay-offer',  relayHelper('relay', 'sdp',       MAX_SDP_LEN, 'offer'))
    socket.on('relay-answer', relayHelper('relay', 'sdp',       MAX_SDP_LEN, 'answer'))
    socket.on('relay-ice',    relayHelper('relay', 'candidate', MAX_ICE_LEN, 'ice-candidate'))

    // ---- [4b] SAS verification confirmation (relay only; opaque to server) ----
    socket.on('verify-confirm', (payload: unknown) => {
      try {
        if (!gate(socket, 'verify')) return
        const { roomId } = (payload || {}) as Record<string, unknown>
        if (!isStr(roomId, ROOMID_LEN, ROOMID_RE)) return
        const room = rooms.get(roomId)
        if (!room) return
        if (room.socketA !== socket.id && room.socketB !== socket.id) return
        const other = room.socketA === socket.id ? room.socketB : room.socketA
        if (other) io.to(other).emit('peer-verify-confirmed')
      } catch (e) {
        console.error('[signaling] verify-confirm handler error', e)
      }
    })

    // ---- [5] Hangup ----
    socket.on('hangup', (payload: unknown) => {
      try {
        if (!gate(socket, 'hangup')) return
        const { roomId } = (payload || {}) as Record<string, unknown>
        if (!isStr(roomId, ROOMID_LEN, ROOMID_RE)) return
        const room = rooms.get(roomId)
        if (!room) return
        if (room.socketA !== socket.id && room.socketB !== socket.id) return
        const otherSocket = room.socketA === socket.id ? room.socketB : room.socketA
        if (otherSocket) io.to(otherSocket).emit('peer-hung-up')
        rooms.delete(roomId)
        console.log(`[signaling] room deleted: ${roomId} (total: ${rooms.size})`)
      } catch (e) {
        console.error('[signaling] hangup handler error', e)
      }
    })

    // ---- Disconnect handler ----
    socket.on('disconnect', () => {
      rooms.forEach((room, roomId) => {
        if (room.socketA === socket.id || room.socketB === socket.id) {
          const otherSocket = room.socketA === socket.id ? room.socketB : room.socketA
          if (otherSocket) io.to(otherSocket).emit('peer-hung-up')
          rooms.delete(roomId)
          console.log(`[signaling] room cleaned on disconnect: ${roomId}`)
        }
      })
      socketState.delete(socket)
    })
  })
}
