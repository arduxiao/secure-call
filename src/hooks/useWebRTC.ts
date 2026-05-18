'use client'
import { useRef, useCallback, useState } from 'react'
import { encrypt, decrypt } from '@/lib/crypto'

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  ...(process.env.NEXT_PUBLIC_TURN_URL ? [{
    urls: process.env.NEXT_PUBLIC_TURN_URL,
    username: process.env.NEXT_PUBLIC_TURN_USERNAME,
    credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL,
  }] : [])
]

interface UseWebRTCOptions {
  roomId: string
  isInitiator: boolean
  sharedKey: Uint8Array
  onOffer: (encryptedSdp: string) => void
  onAnswer: (encryptedSdp: string) => void
  onIceCandidate: (encryptedCandidate: string, fromA: boolean) => void
  onConnected: () => void
  onDisconnected: () => void
}

export function useWebRTC(options: UseWebRTCOptions) {
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const remoteStreamRef = useRef<MediaStream | null>(null)
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const isInitiatorRef = useRef(options.isInitiator)

  const createPeerConnection = useCallback(() => {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    pcRef.current = pc

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        try {
          const candidateStr = JSON.stringify(event.candidate)
          const encrypted = encrypt(candidateStr, options.sharedKey)
          options.onIceCandidate(encrypted, isInitiatorRef.current)
        } catch (e) {
          console.error('[webrtc] ice encrypt error')
        }
      }
    }

    pc.ontrack = (event) => {
      const stream = event.streams[0]
      if (stream) {
        remoteStreamRef.current = stream
        setRemoteStream(stream)
      }
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        setIsConnected(true)
        options.onConnected()
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        options.onDisconnected()
      }
    }

    return pc
  }, [options])

  const startCall = useCallback(async (withVideo: boolean) => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: withVideo
    })
    localStreamRef.current = stream
    setLocalStream(stream)

    const pc = createPeerConnection()
    stream.getTracks().forEach(track => pc.addTrack(track, stream))

    if (isInitiatorRef.current) {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      const encrypted = encrypt(JSON.stringify(offer), options.sharedKey)
      options.onOffer(encrypted)
    }

    return stream
  }, [createPeerConnection, options])

  const handleEncryptedOffer = useCallback(async (encryptedSdp: string, withVideo: boolean) => {
    const pc = createPeerConnection()

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: withVideo
    })
    localStreamRef.current = stream
    setLocalStream(stream)
    stream.getTracks().forEach(track => pc.addTrack(track, stream))

    const offerStr = decrypt(encryptedSdp, options.sharedKey)
    const offer = JSON.parse(offerStr) as RTCSessionDescriptionInit
    await pc.setRemoteDescription(new RTCSessionDescription(offer))

    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    const encryptedAnswer = encrypt(JSON.stringify(answer), options.sharedKey)
    options.onAnswer(encryptedAnswer)

    return stream
  }, [createPeerConnection, options])

  const handleEncryptedAnswer = useCallback(async (encryptedSdp: string) => {
    const pc = pcRef.current
    if (!pc) return
    const answerStr = decrypt(encryptedSdp, options.sharedKey)
    const answer = JSON.parse(answerStr) as RTCSessionDescriptionInit
    await pc.setRemoteDescription(new RTCSessionDescription(answer))
  }, [options.sharedKey])

  const handleEncryptedIce = useCallback(async (encryptedCandidate: string) => {
    const pc = pcRef.current
    if (!pc) return
    try {
      const candidateStr = decrypt(encryptedCandidate, options.sharedKey)
      const candidate = JSON.parse(candidateStr) as RTCIceCandidateInit
      await pc.addIceCandidate(new RTCIceCandidate(candidate))
    } catch (e) {
      console.error('[webrtc] ice decrypt/add error')
    }
  }, [options.sharedKey])

  const cleanup = useCallback(() => {
    localStreamRef.current?.getTracks().forEach(t => t.stop())
    remoteStreamRef.current?.getTracks().forEach(t => t.stop())
    pcRef.current?.close()
    pcRef.current = null
    localStreamRef.current = null
    remoteStreamRef.current = null
    setLocalStream(null)
    setRemoteStream(null)
    setIsConnected(false)
  }, [])

  const toggleMute = useCallback(() => {
    const stream = localStreamRef.current
    if (!stream) return false
    const audioTrack = stream.getAudioTracks()[0]
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled
      return !audioTrack.enabled
    }
    return false
  }, [])

  const toggleCamera = useCallback(() => {
    const stream = localStreamRef.current
    if (!stream) return false
    const videoTrack = stream.getVideoTracks()[0]
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled
      return !videoTrack.enabled
    }
    return false
  }, [])

  return {
    localStream,
    remoteStream,
    isConnected,
    startCall,
    handleEncryptedOffer,
    handleEncryptedAnswer,
    handleEncryptedIce,
    cleanup,
    toggleMute,
    toggleCamera,
  }
}
