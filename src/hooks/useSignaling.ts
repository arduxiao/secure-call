'use client'
import { useEffect, useRef, useCallback, useState } from 'react'
import { io, Socket } from 'socket.io-client'

export function useSignaling() {
  const socketRef = useRef<Socket | null>(null)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    // 优先用环境变量，否则用当前页面 origin（明确传值比 io() 无参更可靠）
    const socketUrl =
      process.env.NEXT_PUBLIC_SOCKET_URL ||
      (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000')

    const socket = io(socketUrl, {
      transports: ['polling', 'websocket'],
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
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

  const on = useCallback((event: string, handler: (...args: unknown[]) => void) => {
    socketRef.current?.on(event, handler)
    return () => {
      socketRef.current?.off(event, handler)
    }
  }, [])

  const off = useCallback((event: string, handler?: (...args: unknown[]) => void) => {
    if (handler) {
      socketRef.current?.off(event, handler)
    } else {
      socketRef.current?.off(event)
    }
  }, [])

  return { emit, on, off, socket: socketRef, connected }
}
