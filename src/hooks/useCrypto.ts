'use client'
import { useRef, useCallback } from 'react'
import { generateEphemeralKeyPair, computeSharedKey } from '@/lib/crypto'

export function useCrypto() {
  const secretKeyRef = useRef<Uint8Array | null>(null)
  const publicKeyB64Ref = useRef<string | null>(null)
  const sharedKeyRef = useRef<Uint8Array | null>(null)

  const generateKeys = useCallback(() => {
    const { publicKeyB64, secretKey } = generateEphemeralKeyPair()
    secretKeyRef.current = secretKey
    publicKeyB64Ref.current = publicKeyB64
    return publicKeyB64
  }, [])

  const deriveSharedKey = useCallback((theirPubKeyB64: string) => {
    if (!secretKeyRef.current) throw new Error('No secret key')
    const shared = computeSharedKey(theirPubKeyB64, secretKeyRef.current)
    sharedKeyRef.current = shared
    return shared
  }, [])

  const destroyKeys = useCallback(() => {
    if (secretKeyRef.current) {
      secretKeyRef.current.fill(0)
      secretKeyRef.current = null
    }
    if (sharedKeyRef.current) {
      sharedKeyRef.current.fill(0)
      sharedKeyRef.current = null
    }
    publicKeyB64Ref.current = null
  }, [])

  return {
    publicKeyB64: publicKeyB64Ref,
    sharedKey: sharedKeyRef,
    generateKeys,
    deriveSharedKey,
    destroyKeys,
  }
}
