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

  const io = new SocketIOServer(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    allowEIO3: true,
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
