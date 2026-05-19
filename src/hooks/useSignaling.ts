'use client'
import { useEffect, useRef, useCallback, useState } from 'react'
import { io, Socket } from 'socket.io-client'
import type { ServerEvents } from '@/lib/protocol'

type ServerEventName = keyof ServerEvents
// Void-payload events should accept () => void handlers instead of forcing
// callers to write (payload: void) => void.
type Handler<K extends ServerEventName> =
  [ServerEvents[K]] extends [void]
    ? () => void
    : (payload: ServerEvents[K]) => void

export function useSignaling() {
  const socketRef = useRef<Socket | null>(null)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    // Socket.IO 服务器与前端同源部署，必须连到当前页面 origin。
    // 不再使用 NEXT_PUBLIC_SOCKET_URL —— 一旦配错（如域名带随机后缀）
    // 客户端会连到不存在的域名并被 CORS 拦截。
    const socketUrl = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000'

    // No auto-reconnect: Socket.IO's reconnect would mint a fresh socket.id on the
    // server side, leaving the existing room's socketA/socketB stale and unreachable.
    // Without a server-side rebind protocol that's worse than just dropping the call
    // honestly. page.tsx watches the `connected` flag and resets active call views
    // when this flips to false.
    const socket = io(socketUrl, {
      transports: ['polling', 'websocket'],
      reconnection: false,
    })

    socketRef.current = socket

    socket.on('connect', () => setConnected(true))
    socket.on('disconnect', () => setConnected(false))
    socket.on('connect_error', (err) => {
      console.error('[signaling] connect error:', err.message)
    })

    return () => {
      socket.disconnect()
      socketRef.current = null
      setConnected(false)
    }
  }, [])

  const emit = useCallback((event: string, data?: unknown) => {
    if (socketRef.current?.connected) {
      socketRef.current.emit(event, data)
    }
  }, [])

  const on = useCallback(<K extends ServerEventName>(event: K, handler: Handler<K>) => {
    // socket.io's typings widen the handler to (...args: any[]); we narrow at the call site.
    const wrapped = (payload: ServerEvents[K]) => (handler as (p: ServerEvents[K]) => void)(payload)
    socketRef.current?.on(event as string, wrapped as (...args: unknown[]) => void)
    return () => {
      socketRef.current?.off(event as string, wrapped as (...args: unknown[]) => void)
    }
  }, [])

  return { emit, on, connected }
}
