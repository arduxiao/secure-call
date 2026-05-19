import { createServer } from 'http'
import { parse } from 'url'
import next from 'next'
import { Server as SocketIOServer } from 'socket.io'
import { registerSignalingHandlers } from './src/server/signaling'

console.log('[server] Starting...')
console.log(`[server] NODE_ENV=${process.env.NODE_ENV}, PORT=${process.env.PORT}`)

const dev = process.env.NODE_ENV !== 'production'
const app = next({ dev })
const handle = app.getRequestHandler()

// Resolve allowed CORS origins ONCE at startup so misconfig fails fast.
// Priority:
//   1. ALLOWED_ORIGIN env (comma-separated for staging/preview deploys)
//   2. RENDER_EXTERNAL_URL — auto-injected by Render so prod "just works"
// If neither is set in production, refuse to start.
function resolveAllowedOrigins(): Set<string> {
  const raw = (process.env.ALLOWED_ORIGIN ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const fromRender = process.env.RENDER_EXTERNAL_URL?.trim()
  const set = new Set<string>(raw)
  if (fromRender) set.add(fromRender)
  return set
}
const ALLOWED_ORIGINS = resolveAllowedOrigins()

if (!dev && ALLOWED_ORIGINS.size === 0) {
  console.error('[server] FATAL: NODE_ENV=production but neither ALLOWED_ORIGIN nor RENDER_EXTERNAL_URL is set. Refusing to start.')
  console.error('[server] Set ALLOWED_ORIGIN=https://your-domain in render.yaml or env, or rely on Render\'s RENDER_EXTERNAL_URL.')
  process.exit(1)
}
console.log(`[server] CORS allow-list: ${dev ? '(dev: localhost + ' : '('}${[...ALLOWED_ORIGINS].join(', ') || '∅'})`)

console.log('[server] Calling app.prepare()...')

app.prepare().then(() => {
  console.log('[server] app.prepare() done, creating HTTP server...')

  const httpServer = createServer((req, res) => {
    const parsedUrl = parse(req.url!, true)
    handle(req, res, parsedUrl)
  })

  // Same-origin only. Allow-list built at startup (see resolveAllowedOrigins above).
  // Dev mode additionally accepts http(s)://localhost or 127.0.0.1 on any port.
  const corsOrigin = (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
    if (!origin) return cb(null, true)  // same-origin or non-browser request (no Origin header)
    if (ALLOWED_ORIGINS.has(origin)) return cb(null, true)
    if (dev && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true)
    return cb(new Error(`Origin ${origin} not allowed`))
  }

  const io = new SocketIOServer(httpServer, {
    cors: { origin: corsOrigin, methods: ['GET', 'POST'], credentials: false },
    // Cap message size to ~128KB. SDP+ICE encrypted blobs are far smaller; this is the
    // outer Socket.IO frame limit, complementing the per-event caps in signaling.ts.
    maxHttpBufferSize: 128 * 1024,
  })

  registerSignalingHandlers(io)
  console.log('[server] Socket.IO signaling handlers registered')

  const port = parseInt(process.env.PORT || '3000', 10)
  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`[server] Ready on http://0.0.0.0:${port}`)
  })
}).catch((err: Error) => {
  console.error('[server] app.prepare() failed:', err)
  process.exit(1)
})
