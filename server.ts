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
    }
  })

  registerSignalingHandlers(io)

  const port = parseInt(process.env.PORT || '3000', 10)
  httpServer.listen(port, () => {
    console.log(`Ready on http://localhost:${port}`)
  })
})
