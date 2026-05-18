'use client'
import { useEffect, useRef, useCallback } from 'react'
import { io, Socket } from 'socket.io-client'

export function useSignaling() {
  const socketRef = useRef<Socket | null>(null)

  useEffect(() => {
    const socketUrl = process.env.NEXT_PUBLIC_SOCKET_URL || ''
    const socket = io(socketUrl, {
      transports: ['websocket', 'polling'],
    })
    socketRef.current = socket

    return () => {
      socket.disconnect()
      socketRef.current = null
    }
  }, [])

  const emit = useCallback((event: string, data?: unknown) => {
    socketRef.current?.emit(event, data)
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

  return { emit, on, off, socket: socketRef }
}
