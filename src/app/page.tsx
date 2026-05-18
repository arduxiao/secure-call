'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { InvitePanel } from '@/components/InvitePanel'
import { WaitingScreen } from '@/components/WaitingScreen'
import { JoinPanel } from '@/components/JoinPanel'
import { CallScreen } from '@/components/CallScreen'
import { useSignaling } from '@/hooks/useSignaling'
import { useCrypto } from '@/hooks/useCrypto'
import { encrypt, decrypt } from '@/lib/crypto'
import { Lock } from 'lucide-react'

type View = 'home' | 'waiting' | 'join' | 'call'
type JoinStatus = 'idle' | 'looking' | 'found' | 'not-found'
type CallMode = 'audio' | 'video'

export default function HomePage() {
  const [view, setView] = useState<View>('home')
  const [isInitiator, setIsInitiator] = useState(false)
  const [roomId, setRoomId] = useState('')
  const [symbolString, setSymbolString] = useState('')
  const [joinStatus, setJoinStatus] = useState<JoinStatus>('idle')
  const [joinedSymbol, setJoinedSymbol] = useState<string | null>(null)
  const [callMode, setCallMode] = useState<CallMode>('audio')
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)

  const { emit, on, socket, connected } = useSignaling()
  const crypto = useCrypto()
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null)
  const sharedKeyRef = useRef<Uint8Array | null>(null)
  const roomIdRef = useRef('')
  const isInitiatorRef = useRef(false)

  const ICE_SERVERS: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ]

  const cleanup = useCallback(() => {
    localStream?.getTracks().forEach(t => t.stop())
    remoteStream?.getTracks().forEach(t => t.stop())
    peerConnectionRef.current?.close()
    peerConnectionRef.current = null
    crypto.destroyKeys()
    if (sharedKeyRef.current) {
      sharedKeyRef.current.fill(0)
      sharedKeyRef.current = null
    }
    setLocalStream(null)
    setRemoteStream(null)
  }, [localStream, remoteStream, crypto])

  const resetToHome = useCallback(() => {
    const currentRoomId = roomIdRef.current
    cleanup()
    setView('home')
    setRoomId('')
    setSymbolString('')
    setJoinStatus('idle')
    setJoinedSymbol(null)
    roomIdRef.current = ''
    isInitiatorRef.current = false
    if (currentRoomId) emit('hangup', { roomId: currentRoomId })
  }, [cleanup, emit])

  const setupPeerConnection = useCallback(() => {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    peerConnectionRef.current = pc

    pc.onicecandidate = (event) => {
      if (event.candidate && sharedKeyRef.current) {
        try {
          const candidateStr = JSON.stringify(event.candidate.toJSON())
          const encrypted = encrypt(candidateStr, sharedKeyRef.current)
          emit('relay-ice', {
            roomId: roomIdRef.current,
            candidate: encrypted,
            fromA: isInitiatorRef.current
          })
        } catch (_) {}
      }
    }

    pc.ontrack = (event) => {
      const stream = event.streams[0]
      if (stream) setRemoteStream(stream)
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        setView('call')
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        resetToHome()
      }
    }

    return pc
  }, [emit, resetToHome])

  // Initiator: listen for peer-joined
  useEffect(() => {
    const off = on('peer-joined', async ({ pubKeyB, callMode: remoteMode }: any) => {
      if (!crypto.publicKeyB64.current) return
      const shared = crypto.deriveSharedKey(pubKeyB)
      sharedKeyRef.current = shared

      const resolvedMode: CallMode = remoteMode === 'video' ? 'video' : 'audio'
      setCallMode(resolvedMode)

      const pc = setupPeerConnection()

      try {
        const mode = resolvedMode === 'video' ? { audio: true, video: true } : { audio: true, video: false }
        const stream = await navigator.mediaDevices.getUserMedia(mode)
        setLocalStream(stream)
        stream.getTracks().forEach(track => pc.addTrack(track, stream))

        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        const encrypted = encrypt(JSON.stringify({ type: offer.type, sdp: offer.sdp }), shared)
        emit('relay-offer', { roomId: roomIdRef.current, sdp: encrypted })
      } catch (e) {
        console.error('[webrtc] offer error')
        resetToHome()
      }
    })
    return () => off()
  }, [on, crypto, setupPeerConnection, emit, resetToHome])

  // Acceptor: listen for offer
  useEffect(() => {
    const off = on('offer', async ({ sdp: encryptedSdp }: any) => {
      if (!sharedKeyRef.current) return
      try {
        const pc = setupPeerConnection()
        const offerStr = decrypt(encryptedSdp, sharedKeyRef.current)
        const offerData = JSON.parse(offerStr)

        const mode = callMode === 'video' ? { audio: true, video: true } : { audio: true, video: false }
        const stream = await navigator.mediaDevices.getUserMedia(mode)
        setLocalStream(stream)
        stream.getTracks().forEach(track => pc.addTrack(track, stream))

        await pc.setRemoteDescription(new RTCSessionDescription(offerData))
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        const encrypted = encrypt(JSON.stringify({ type: answer.type, sdp: answer.sdp }), sharedKeyRef.current)
        emit('relay-answer', { roomId: roomIdRef.current, sdp: encrypted })
      } catch (e) {
        console.error('[webrtc] answer error')
        resetToHome()
      }
    })
    return () => off()
  }, [on, setupPeerConnection, emit, callMode, resetToHome])

  // Listen for answer
  useEffect(() => {
    const off = on('answer', async ({ sdp: encryptedSdp }: any) => {
      if (!sharedKeyRef.current || !peerConnectionRef.current) return
      try {
        const answerStr = decrypt(encryptedSdp, sharedKeyRef.current)
        const answerData = JSON.parse(answerStr)
        await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(answerData))
      } catch (e) {
        console.error('[webrtc] set answer error')
      }
    })
    return () => off()
  }, [on])

  // Listen for ICE candidates
  useEffect(() => {
    const off = on('ice-candidate', async ({ candidate: encryptedCandidate }: any) => {
      if (!sharedKeyRef.current || !peerConnectionRef.current) return
      try {
        const candidateStr = decrypt(encryptedCandidate, sharedKeyRef.current)
        const candidate = JSON.parse(candidateStr)
        await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate))
      } catch (e) {
        console.error('[webrtc] ice add error')
      }
    })
    return () => off()
  }, [on])

  // Listen for peer hangup
  useEffect(() => {
    const off = on('peer-hung-up', () => {
      cleanup()
      setView('home')
      setRoomId('')
      setSymbolString('')
      setJoinStatus('idle')
      setJoinedSymbol(null)
    })
    return () => off()
  }, [on, cleanup])

  const handleInvite = useCallback((newRoomId: string, symbols: string) => {
    const pubKey = crypto.generateKeys()
    roomIdRef.current = newRoomId
    isInitiatorRef.current = true
    setIsInitiator(true)
    setRoomId(newRoomId)
    setSymbolString(symbols)
    emit('create-room', { roomId: newRoomId, symbols, pubKeyA: pubKey })
    setView('waiting')
  }, [crypto, emit])

  const handleCancelInvite = useCallback(() => {
    emit('hangup', { roomId: roomIdRef.current })
    cleanup()
    setView('home')
    setRoomId('')
    setSymbolString('')
  }, [emit, cleanup])

  const handleLookup = useCallback((code: string) => {
    setJoinStatus('looking')
    roomIdRef.current = code

    crypto.generateKeys()

    const offInfo = on('room-info', ({ symbols, pubKeyA }: any) => {
      clearTimeout(timer)
      const shared = crypto.deriveSharedKey(pubKeyA)
      sharedKeyRef.current = shared
      setJoinedSymbol(symbols)
      setJoinStatus('found')
      offInfo()
      offNotFound()
    })

    const offNotFound = on('room-not-found', () => {
      clearTimeout(timer)
      setJoinStatus('not-found')
      offInfo()
      offNotFound()
    })

    // 5 秒无响应视为失败（Socket.IO 未连接或房间不存在）
    const timer = setTimeout(() => {
      offInfo()
      offNotFound()
      setJoinStatus('not-found')
    }, 5000)

    emit('lookup-room', { roomId: code })
  }, [crypto, on, emit])

  const handleAccept = useCallback(async (mode: CallMode) => {
    setCallMode(mode)
    isInitiatorRef.current = false
    const pubKey = crypto.publicKeyB64.current
    if (!pubKey) return
    emit('join-room', { roomId: roomIdRef.current, pubKeyB: pubKey, callMode: mode })
  }, [crypto, emit])

  const handleHangup = useCallback(() => {
    emit('hangup', { roomId: roomIdRef.current })
    cleanup()
    setView('home')
    setRoomId('')
    setSymbolString('')
    setJoinStatus('idle')
    setJoinedSymbol(null)
    roomIdRef.current = ''
  }, [emit, cleanup])

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {view !== 'call' && (
        <header className="fixed top-0 left-0 right-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-sm">
          <div className="max-w-md mx-auto px-4 h-12 flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Lock className="w-3 h-3" />
              <span>端对端加密</span>
            </div>
            <span className="text-xs font-mono text-muted-foreground/60">SecureCall</span>
          </div>
        </header>
      )}

      <main className="flex-1 flex flex-col items-center justify-center pt-16 pb-12 px-4">
        <div className="w-full max-w-md">
          {view === 'home' && (
            <div className="space-y-6">
              <div className="text-center space-y-1">
                <h1 className="text-xl font-semibold">安全通话</h1>
                <p className="text-sm text-muted-foreground">端对端加密 · 暗语标志身份确认 · 零痕迹</p>
              </div>
              <div className="text-xs text-muted-foreground bg-muted/40 rounded-lg px-4 py-3 space-y-1">
                <p className="font-medium text-foreground mb-1">使用流程</p>
                <p>① 发起方：选好暗语标志（颜色/形状/数量含义事先与对方约好）→ 发起邀请</p>
                <p>② 发起方：把 8 位房间码发给对方</p>
                <p>③ 接受方：点「加入通话」→ 输入房间码 → 识别标志 → 接听</p>
              </div>
              <InvitePanel
                onInvite={handleInvite}
                onJoinMode={() => setView('join')}
                connected={connected}
              />
            </div>
          )}

          {view === 'waiting' && (
            <WaitingScreen
              roomId={roomId}
              symbolString={symbolString}
              onCancel={handleCancelInvite}
            />
          )}

          {view === 'join' && (
            <JoinPanel
              onLookup={handleLookup}
              onAcceptAudio={() => handleAccept('audio')}
              onAcceptVideo={() => handleAccept('video')}
              onReject={() => {
                emit('hangup', { roomId: roomIdRef.current })
                setView('home')
                setJoinStatus('idle')
                setJoinedSymbol(null)
              }}
              onBack={() => { setView('home'); setJoinStatus('idle'); setJoinedSymbol(null) }}
              symbolString={joinedSymbol}
              status={joinStatus}
              connected={connected}
            />
          )}

          {view === 'call' && (
            <CallScreen
              localStream={localStream}
              remoteStream={remoteStream}
              hasVideo={callMode === 'video'}
              onHangup={handleHangup}
            />
          )}
        </div>
      </main>

      {view !== 'call' && (
        <footer className="fixed bottom-0 left-0 right-0 py-3 text-center">
          <p className="text-xs text-muted-foreground/50">通话结束后信令与密钥自动销毁</p>
        </footer>
      )}
    </div>
  )
}
