// Adversarial test: exercises the server-side guards added in N3+N4.
//
// S1  Forged answer  — B (acceptor) sends a relay-answer that should travel
//                      A → B. After N4 the server drops it and A receives
//                      nothing. We verify A sees no 'answer' event within 1s.
// S2  Per-IP burst   — open 30 sockets from the same client (test runner) and
//                      fire 600 lookup-room calls. Per-IP limit is 20 burst +
//                      1/sec sustained → server must emit 'rate-limited' for
//                      the vast majority. We accept ≥ 80% rate-limit responses.
//
// Talks directly to the Socket.IO endpoint; no browser/getUserMedia needed.
import { io as ioClient } from '/Users/warnerroth/sims/secure-call/node_modules/socket.io-client/build/esm/index.js'

const TEST_URL = process.env.TEST_URL || 'http://localhost:3000'
const log = (tag, msg) => console.log(`[${tag}] ${msg}`)

// Crockford-ish base32 alphabet (mirror src/lib/roomCode.ts)
const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const code = () => {
  const a = new Uint8Array(8); globalThis.crypto.getRandomValues(a)
  return Array.from(a, b => ALPH[b % ALPH.length]).join('')
}
// Construct a valid-shaped public key (44 base64 chars ending in '=').
const fakePub = (seed) => {
  const buf = new Uint8Array(32); for (let i = 0; i < 32; i++) buf[i] = (seed * 31 + i * 7) & 0xff
  // base64 32 bytes → 44 chars + 1 '=' padding
  return Buffer.from(buf).toString('base64')
}

function connect() {
  return new Promise((resolve, reject) => {
    const s = ioClient(TEST_URL, { transports: ['websocket', 'polling'], reconnection: false, timeout: 5000 })
    s.once('connect', () => resolve(s))
    s.once('connect_error', reject)
    setTimeout(() => reject(new Error('connect timeout')), 5000)
  })
}

// ─────────────────────────────────────────────────────────────────────────
// S1 : forged answer rejected
// ─────────────────────────────────────────────────────────────────────────
async function scenarioForgedAnswer() {
  log('S1', 'B sends relay-answer (forbidden) — A must NOT receive answer')
  const a = await connect()
  const b = await connect()
  const roomId = code()
  let aGotAnswer = false
  a.on('answer', () => { aGotAnswer = true })

  // A creates room, B joins, then B (illegally) emits relay-answer.
  await new Promise((resolve, reject) => {
    a.once('room-created', resolve); a.once('error', e => reject(new Error(`A create error: ${e.message}`)))
    a.emit('create-room', { roomId, symbols: '△ 🟢', pubKeyA: fakePub(1) })
  })
  // B looks up + joins (server transitions room.state to connecting).
  await new Promise((resolve, reject) => {
    b.once('room-info', resolve); b.once('room-not-found', () => reject(new Error('B lookup failed')))
    b.emit('lookup-room', { roomId })
  })
  b.emit('join-room', { roomId, pubKeyB: fakePub(2), callMode: 'audio', symbolsB: '○ 🟡' })

  // Give server a tick to route peer-joined → A.
  await new Promise(r => setTimeout(r, 100))

  // B emits relay-answer — server SHOULD drop it (B isn't allowed to send answer).
  b.emit('relay-answer', { roomId, sdp: 'PLAUSIBLE-OPAQUE-BLOB' })
  await new Promise(r => setTimeout(r, 800))

  a.disconnect(); b.disconnect()
  if (aGotAnswer) { log('S1-FAIL', 'A received forged answer — sender-role guard broken'); process.exitCode = 1 }
  else            { log('S1-PASS', 'forged relay-answer was dropped by server') }
}

// ─────────────────────────────────────────────────────────────────────────
// S2 : per-IP rate limit holds across many sockets
// ─────────────────────────────────────────────────────────────────────────
async function scenarioPerIPLimit() {
  log('S2', 'open 30 sockets from one IP and burst 600 lookups')
  const N_SOCK = 30
  const PER_SOCK = 20
  const sockets = await Promise.all(Array.from({ length: N_SOCK }, () => connect()))
  let rateLimited = 0, notFound = 0, info = 0
  for (const s of sockets) {
    s.on('rate-limited', () => { rateLimited++ })
    s.on('room-not-found', () => { notFound++ })
    s.on('room-info', () => { info++ })
  }
  // Burst lookups: each socket fires PER_SOCK lookups for non-existent rooms.
  const burst = code => code  // helper to keep types honest
  for (const s of sockets) {
    for (let i = 0; i < PER_SOCK; i++) s.emit('lookup-room', { roomId: burst(code()) })
  }
  // Let server drain.
  await new Promise(r => setTimeout(r, 2500))
  const total = N_SOCK * PER_SOCK
  log('S2', `total=${total}  rate-limited=${rateLimited}  not-found=${notFound}  room-info=${info}`)
  sockets.forEach(s => s.disconnect())

  // Bucket math: 20 capacity + 1/s × ~3s ≈ 23 lookups succeed → ~577 are rate-limited.
  // We accept ≥ 80% (≥ 480) as proof the per-IP gate is biting.
  if (rateLimited < total * 0.8) {
    log('S2-FAIL', `rate-limit hit only ${rateLimited}/${total} — per-IP gate not biting hard enough`)
    process.exitCode = 1
  } else {
    log('S2-PASS', `${rateLimited}/${total} requests rate-limited`)
  }
}

// ─────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────
// S3 : symbol regex tightening — bad shapes/mixed/control chars must be rejected
// ─────────────────────────────────────────────────────────────────────────
async function scenarioBadSymbols() {
  log('S3', 'tightened SYMBOL_RE rejects malformed symbols')
  // Per-IP `create` bucket capacity is 5; keep total cases ≤ 5 to avoid bucket exhaustion.
  // Covering the categories that actually matter: count overflow, mixed shapes, unknown
  // shape, unknown color, control char injection.
  const cases = [
    { name: 'mixed shapes',     symbols: '△○ 🟢' },
    { name: '4× shapes',        symbols: '△△△△ 🟢' },
    { name: 'unknown shape',    symbols: 'X 🟢' },
    { name: 'unknown color',    symbols: '△ 🔵' },
    { name: 'RTL override',     symbols: '‮△ 🟢' },
  ]
  let rejected = 0
  for (const c of cases) {
    const s = await connect()
    const got = await new Promise((resolve) => {
      let done = false
      const finish = (verdict) => { if (done) return; done = true; resolve(verdict) }
      s.once('error', ({ message }) => finish(`error:${message}`))
      s.once('rate-limited', ({ event }) => finish(`rate-limited:${event}`))
      s.once('room-created', () => finish('CREATED'))
      s.emit('create-room', { roomId: code(), symbols: c.symbols, pubKeyA: fakePub(1) })
      setTimeout(() => finish('TIMEOUT'), 500)
    })
    s.disconnect()
    const ok = got.startsWith('error:bad-symbols')
    if (ok) rejected++
    log(`S3:case`, `${c.name.padEnd(20)} → ${got} ${ok ? '✓' : '✗'}`)
  }
  if (rejected === cases.length) log('S3-PASS', `all ${cases.length} malformed symbols rejected`)
  else { log('S3-FAIL', `${rejected}/${cases.length} rejected`); process.exitCode = 1 }
}

async function run() {
  await scenarioForgedAnswer()
  await scenarioPerIPLimit()
  // S3 talks to a fresh socket each iteration — rate-limit reset matters; insert a small pause
  // after the burst test so the create-room bucket has refilled enough for S3's 7 attempts.
  await new Promise(r => setTimeout(r, 2500))
  await scenarioBadSymbols()
}

const HARD_TIMEOUT_MS = 30_000
const guard = setTimeout(() => { console.error(`FATAL hard timeout ${HARD_TIMEOUT_MS}ms`); process.exit(2) }, HARD_TIMEOUT_MS)
run()
  .catch(e => { console.error('FATAL', e); process.exitCode = 1 })
  .finally(() => clearTimeout(guard))
