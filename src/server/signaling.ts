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
const MAX_SYMBOLS_LEN = 16            // tight: 1-3 shape chars + space + 1 color emoji (2 UTF-16 units) ≤ 6 code units
const PUBKEY_BYTES = 32               // X25519 raw public key length
const MAX_SDP_LEN = 64 * 1024         // 64 KB encrypted SDP (full audio+video SDP is ~3-5KB plaintext)
const MAX_ICE_LEN = 4 * 1024          // 4 KB encrypted ICE candidate
const MAX_RELAY_TOTAL_BYTES = MAX_SDP_LEN * 4  // hard ceiling across one call
const MAX_ROOMS = Math.max(1, parseInt(process.env.MAX_ROOMS || '5000', 10))  // global cap on concurrent rooms — defends against memory growth. Env override for tests.

// Crockford-ish base32 — must mirror src/lib/roomCode.ts ROOM_CODE_ALPHABET.
const ROOMID_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/
const PUBKEY_RE = /^[A-Za-z0-9+/]{43}=$/        // 32-byte base64 always ends in single '='
// Closed-set symbol: one of the 5 shape glyphs repeated 1-3× then space then one
// of the 4 color emoji. Backreference \1 forces all repeats to be the SAME shape.
// Matches whatever buildSymbolString() in src/lib/symbols.ts can produce, and
// rejects control chars / RTL overrides / zero-width chars used for UI spoofing.
const SYMBOL_RE = /^([△○□◇✦])\1{0,2} [🟢🟡🟠🔴]$/u

// Defense-in-depth: confirm the base64 actually decodes to a 32-byte payload.
// The regex above already pins length & alphabet, but decode-check catches the
// rare case where padding/character interaction produces a different byte count.
function isPubKey(v: unknown): v is string {
  return typeof v === 'string' && PUBKEY_RE.test(v) && Buffer.from(v, 'base64').length === PUBKEY_BYTES
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate limits — token bucket per event family, keyed BY CLIENT IP (not socket)
// so the obvious bypass "open many sockets" doesn't work. Numbers picked so a
// legitimate user has plenty of headroom (lookup retry, ICE trickle) but a
// flooder gets throttled fast.
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

// Client IP. Render (and most PaaS) put the real client IP into X-Forwarded-For;
// the first comma-separated entry is the client, the rest are proxies. If no
// XFF header (direct connect), fall back to the socket's remote address.
function clientIP(socket: Socket): string {
  const xff = socket.handshake.headers['x-forwarded-for']
  const first = (typeof xff === 'string' ? xff : Array.isArray(xff) ? xff[0] : undefined)?.split(',')[0]?.trim()
  return first || socket.handshake.address || 'unknown'
}

// Per-IP rate-limit bucket pool. GC'd on a timer below so we don't grow forever.
interface IPState { buckets: Record<LimitKey, Bucket>; lastSeen: number }
const ipState = new Map<string, IPState>()

function ipStateFor(socket: Socket): IPState {
  const ip = clientIP(socket)
  let s = ipState.get(ip)
  if (!s) { s = { buckets: makeBuckets(), lastSeen: Date.now() }; ipState.set(ip, s) }
  s.lastSeen = Date.now()
  return s
}

// Per-socket relay-byte accounting: a single socket can only push so much
// encrypted payload through us before we cut them off. Kept separate from the
// per-IP bucket because legitimate users may run multiple back-to-back calls.
interface SocketState { relayBytes: number }
const socketState = new WeakMap<Socket, SocketState>()

function socketStateFor(socket: Socket): SocketState {
  let s = socketState.get(socket)
  if (!s) { s = { relayBytes: 0 }; socketState.set(socket, s) }
  return s
}

function gate(socket: Socket, key: LimitKey): boolean {
  if (!spend(ipStateFor(socket).buckets[key])) {
    socket.emit('rate-limited', { event: key })
    return false
  }
  return true
}

// Sweep stale IP entries every 5 min; drop anything idle > 30 min so the Map
// doesn't accumulate indefinitely from one-off visitors.
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000
  for (const [ip, st] of ipState) if (st.lastSeen < cutoff) ipState.delete(ip)
}, 5 * 60 * 1000).unref?.()

// ─────────────────────────────────────────────────────────────────────────────

function isStr(v: unknown, max: number, re?: RegExp): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max && (!re || re.test(v))
}

export function registerSignalingHandlers(io: Server) {
  // Helper: reset the relay-byte budget for a participant once their call ends.
  // Without this, a single socket that completes multiple back-to-back calls
  // keeps accumulating bytes and eventually trips the MAX_RELAY_TOTAL_BYTES
  // safety cap mid-conversation in a later call.
  const resetRelayBudget = (sockId: string | undefined) => {
    if (!sockId) return
    const s = io.sockets.sockets.get(sockId)
    if (s) socketStateFor(s).relayBytes = 0
  }

  io.on('connection', (socket: Socket) => {
    // ---- [1] A creates room ----
    socket.on('create-room', (payload: unknown) => {
      try {
        if (!gate(socket, 'create')) return
        const { roomId, symbols, pubKeyA } = (payload || {}) as Record<string, unknown>
        if (!isStr(roomId, ROOMID_LEN, ROOMID_RE)) return socket.emit('error', { message: 'bad-room-id' })
        if (!isStr(symbols, MAX_SYMBOLS_LEN, SYMBOL_RE)) return socket.emit('error', { message: 'bad-symbols' })
        if (!isPubKey(pubKeyA)) return socket.emit('error', { message: 'bad-pubkey' })

        if (rooms.size >= MAX_ROOMS) {
          console.warn(`[signaling] capacity hit: rooms=${rooms.size} >= ${MAX_ROOMS}`)
          return socket.emit('error', { message: 'capacity' })
        }
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
        if (!isPubKey(pubKeyB)) return socket.emit('error', { message: 'bad-pubkey' })
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
    //
    // Sender-role enforcement:
    //   • relay-offer  MUST come from socketA (only A creates the offer)
    //   • relay-answer MUST come from socketB (only B sends the answer back)
    //   • relay-ice    MAY come from either; direction is derived from socket.id,
    //     not from a client-supplied `fromA` flag (which was trivially forgeable).
    //
    // This closes the "B forges an answer back to A" attack the second-round audit
    // flagged. Anything that doesn't match the expected role is dropped silently.
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
          if (!isStr(roomId, ROOMID_LEN, ROOMID_RE)) return
          if (typeof blob !== 'string' || blob.length === 0 || blob.length > maxLen) return

          const room = rooms.get(roomId)
          if (!room) return
          // Caller must actually be a participant of this room.
          const isA = socket.id === room.socketA
          const isB = socket.id === room.socketB
          if (!isA && !isB) return

          // Role gating per event kind.
          if (forwardEvent === 'offer'  && !isA) return
          if (forwardEvent === 'answer' && !isB) return

          const st = socketStateFor(socket)
          st.relayBytes += blob.length
          if (st.relayBytes > MAX_RELAY_TOTAL_BYTES) {
            console.warn(`[signaling] relay-cap hit, disconnect ${socket.id}`)
            return socket.disconnect(true)
          }

          let target: string | undefined
          if (forwardEvent === 'offer') target = room.socketB
          else if (forwardEvent === 'answer') target = room.socketA
          else target = isA ? room.socketB : room.socketA  // ICE: send to the other end
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
        // The call is over for everyone in this room — clear both peers'
        // accumulated relay-byte counters so the next call starts fresh.
        resetRelayBudget(room.socketA)
        resetRelayBudget(room.socketB)
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
          // Disconnecting socket's WeakMap entry will GC, but the surviving peer
          // (still connected) needs its relay-byte counter cleared so the next
          // call they make starts with a fresh budget.
          resetRelayBudget(otherSocket)
          rooms.delete(roomId)
          console.log(`[signaling] room cleaned on disconnect: ${roomId}`)
        }
      })
      socketState.delete(socket)
    })
  })
}
