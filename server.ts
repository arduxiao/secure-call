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

console.log('[server] Calling app.prepare()...')

app.prepare().then(() => {
  console.log('[server] app.prepare() done, creating HTTP server...')

  const httpServer = createServer((req, res) => {
    const parsedUrl = parse(req.url!, true)
    handle(req, res, parsedUrl)
  })

  // Same-origin only: in production we set ALLOWED_ORIGIN to the deploy URL
  // (e.g. https://secure-call-kn0h.onrender.com). Locally we allow http://localhost:*.
  // A missing/wildcard config is rejected so prod can't accidentally re-open CORS.
  const allowedOrigin = process.env.ALLOWED_ORIGIN
  const corsOrigin = (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
    if (!origin) return cb(null, true)  // same-origin or non-browser requests
    if (allowedOrigin && origin === allowedOrigin) return cb(null, true)
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
