import { createServer } from 'http'
import { parse } from 'url'
import next from 'next'
import { Server as SocketIOServer } from 'socket.io'
import { registerSignalingHandlers } from './src/server/signaling'

const dev = process.env.NODE_ENV !== 'production'
const app = next({ dev })
const handle = app.getRequestHandler()

app.prepare().then(() => {
  const httpServer = createServer((req, res) => {
    const parsedUrl = parse(req.url!, true)
    handle(req, res, parsedUrl)
  })

  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: process.env.CLIENT_ORIGIN || '*',
      methods: ['GET', 'POST']
    },
    // 允许跨域携带凭证
    allowEIO3: true,
  })

  registerSignalingHandlers(io)
  console.log('[server] Socket.IO signaling handlers registered')

  const port = parseInt(process.env.PORT || '3000', 10)
  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`[server] Ready on http://0.0.0.0:${port}`)
    console.log(`[server] NODE_ENV=${process.env.NODE_ENV}`)
  })
}).catch((err) => {
  console.error('[server] Failed to start:', err)
  process.exit(1)
})
