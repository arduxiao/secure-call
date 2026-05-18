import { Server, Socket } from 'socket.io'
import { rooms, Room } from './roomManager'

export function registerSignalingHandlers(io: Server) {
  io.on('connection', (socket: Socket) => {
    // [1] A creates room
    socket.on('create-room', ({ roomId, symbols, pubKeyA }: { roomId: string; symbols: string; pubKeyA: string }) => {
      if (rooms.has(roomId)) {
        socket.emit('error', { message: 'room-exists' })
        return
      }
      const room: Room = {
        symbols,
        pubKeyA,
        socketA: socket.id,
        expiresAt: Date.now() + 15 * 60 * 1000,
        state: 'waiting'
      }
      rooms.set(roomId, room)
      socket.join(roomId)
      socket.emit('room-created', { roomId })
      console.log(`[signaling] room created: ${roomId} (total: ${rooms.size})`)
    })

    // [2] B looks up room
    socket.on('lookup-room', ({ roomId }: { roomId: string }) => {
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
      // Only return symbols and pubKeyA, do not expose other info
      socket.emit('room-info', { symbols: room.symbols, pubKeyA: room.pubKeyA })
    })

    // [3] B accepts, completes ECDH key exchange
    socket.on('join-room', ({ roomId, pubKeyB, callMode }: { roomId: string; pubKeyB: string; callMode?: string }) => {
      const room = rooms.get(roomId)
      if (!room || room.state !== 'waiting') {
        socket.emit('room-not-found')
        return
      }
      room.pubKeyB = pubKeyB
      room.socketB = socket.id
      room.state = 'connecting'
      socket.join(roomId)

      // Notify A that B has joined, tell A B's public key and preferred call mode
      io.to(room.socketA).emit('peer-joined', { pubKeyB, callMode: callMode || 'audio' })

      // After call is established, delete sensitive data
      setTimeout(() => promoteToActive(roomId), 5000)
    })

    // [4] Relay encrypted WebRTC Offer
    socket.on('relay-offer', ({ roomId, sdp }: { roomId: string; sdp: string }) => {
      const room = rooms.get(roomId)
      if (!room || !room.socketB) return
      io.to(room.socketB).emit('offer', { sdp })
    })

    // [4] Relay encrypted WebRTC Answer
    socket.on('relay-answer', ({ roomId, sdp }: { roomId: string; sdp: string }) => {
      const room = rooms.get(roomId)
      if (!room || !room.socketA) return
      io.to(room.socketA).emit('answer', { sdp })
    })

    // [4] Relay encrypted ICE candidate
    socket.on('relay-ice', ({ roomId, candidate, fromA }: { roomId: string; candidate: string; fromA: boolean }) => {
      const room = rooms.get(roomId)
      if (!room) return
      const targetSocket = fromA ? room.socketB : room.socketA
      if (targetSocket) {
        io.to(targetSocket).emit('ice-candidate', { candidate })
      }
    })

    // [5] Hangup
    socket.on('hangup', ({ roomId }: { roomId: string }) => {
      const room = rooms.get(roomId)
      if (room) {
        const otherSocket = room.socketA === socket.id ? room.socketB : room.socketA
        if (otherSocket) {
          io.to(otherSocket).emit('peer-hung-up')
        }
        rooms.delete(roomId)
        console.log(`[signaling] room deleted: ${roomId} (total: ${rooms.size})`)
      }
    })

    // Disconnect handler
    socket.on('disconnect', () => {
      rooms.forEach((room, roomId) => {
        if (room.socketA === socket.id || room.socketB === socket.id) {
          const otherSocket = room.socketA === socket.id ? room.socketB : room.socketA
          if (otherSocket) {
            io.to(otherSocket).emit('peer-hung-up')
          }
          rooms.delete(roomId)
          console.log(`[signaling] room cleaned on disconnect: ${roomId}`)
        }
      })
    })
  })
}

function promoteToActive(roomId: string) {
  const room = rooms.get(roomId)
  if (!room) return
  // Delete sensitive data after call is established
  delete (room as any).pubKeyA
  delete (room as any).pubKeyB
  delete (room as any).symbols
  room.state = 'active'
}
