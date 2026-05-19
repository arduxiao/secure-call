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

type View = 'home' | 'waiting' | 'join' | 'connecting' | 'call'
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
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const { emit, on, socket, connected } = useSignaling()
  const crypto = useCrypto()
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null)
  const sharedKeyRef = useRef<Uint8Array | null>(null)
  const roomIdRef = useRef('')
  const isInitiatorRef = useRef(false)
  // 同步可读的 callMode，避免 setCallMode 异步导致 offer 处理器读到旧值
  const callModeRef = useRef<CallMode>('audio')
  // 同步可读的 view，避免异步事件处理器读到旧值
  const viewRef = useRef<View>('home')
  useEffect(() => { viewRef.current = view }, [view])
  // 同步可读的 localStream，便于在用户点击瞬间预授权，再异步在握手期复用
  const localStreamRef = useRef<MediaStream | null>(null)

  const ICE_SERVERS: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ]

  const cleanup = useCallback(() => {
    localStreamRef.current?.getTracks().forEach(t => t.stop())
    remoteStream?.getTracks().forEach(t => t.stop())
    peerConnectionRef.current?.close()
    peerConnectionRef.current = null
    crypto.destroyKeys()
    if (sharedKeyRef.current) {
      sharedKeyRef.current.fill(0)
      sharedKeyRef.current = null
    }
    localStreamRef.current = null
    setLocalStream(null)
    setRemoteStream(null)
  }, [remoteStream, crypto])

  // 同步存：用 ref 立即可读，避免下一拍渲染前事件处理器看不到流；同时驱动渲染
  const storeLocalStream = useCallback((stream: MediaStream | null) => {
    localStreamRef.current = stream
    setLocalStream(stream)
  }, [])

  const resetToHome = useCallback((reason?: string) => {
    const currentRoomId = roomIdRef.current
    cleanup()
    setView('home')
    setRoomId('')
    setSymbolString('')
    setJoinStatus('idle')
    setJoinedSymbol(null)
    roomIdRef.current = ''
    isInitiatorRef.current = false
    if (reason) setErrorMessage(reason)
    if (currentRoomId) emit('hangup', { roomId: currentRoomId })
  }, [cleanup, emit])

  const mediaErrorReason = (e: unknown, mode: CallMode = 'audio'): string => {
    const name = (e as { name?: string })?.name
    const device = mode === 'video' ? '麦克风或摄像头' : '麦克风'
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return `${device}权限被拒绝。请在浏览器地址栏的锁形图标中允许权限后重试`
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return `未检测到可用${device}`
    if (name === 'NotReadableError') return `${device}被其他应用占用`
    return '建立通话失败，请重试'
  }

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
      } else if (pc.connectionState === 'failed') {
        // 'disconnected' 是瞬时状态，可能自行恢复，不在这里清场；只有 'failed' 才视为不可恢复
        resetToHome('网络连接失败')
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
      callModeRef.current = resolvedMode
      setCallMode(resolvedMode)
      // 对方已加入，进入"正在建立连接"过渡视图，提供清晰反馈
      setView('connecting')

      const pc = setupPeerConnection()

      try {
        // 优先复用 handleInvite 阶段预授权拿到的流；只在对方选视频且本地还没有摄像头轨道时补取摄像头。
        let stream = localStreamRef.current
        if (!stream) {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: resolvedMode === 'video' })
          storeLocalStream(stream)
        } else if (resolvedMode === 'video' && stream.getVideoTracks().length === 0) {
          const videoOnly = await navigator.mediaDevices.getUserMedia({ video: true })
          videoOnly.getVideoTracks().forEach(t => stream!.addTrack(t))
          storeLocalStream(stream)
        }
        stream.getTracks().forEach(track => pc.addTrack(track, stream!))

        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        const encrypted = encrypt(JSON.stringify({ type: offer.type, sdp: offer.sdp }), shared)
        emit('relay-offer', { roomId: roomIdRef.current, sdp: encrypted })
      } catch (e) {
        console.error('[webrtc] offer error', e)
        resetToHome(mediaErrorReason(e, resolvedMode))
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

        // 先 setRemoteDescription（Unified Plan 推荐顺序：先建好 transceivers）
        await pc.setRemoteDescription(new RTCSessionDescription(offerData))

        // 用 ref 读取 callMode，避免闭包捕获旧 state
        const wantVideo = callModeRef.current === 'video'
        // handleAccept 已经预授权并存了本地流，直接复用；缺失时兜底再请求一次
        let stream = localStreamRef.current
        if (!stream) {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: wantVideo })
          storeLocalStream(stream)
        }
        stream.getTracks().forEach(track => pc.addTrack(track, stream!))

        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        const encrypted = encrypt(JSON.stringify({ type: answer.type, sdp: answer.sdp }), sharedKeyRef.current)
        emit('relay-answer', { roomId: roomIdRef.current, sdp: encrypted })
      } catch (e) {
        console.error('[webrtc] answer error', e)
        resetToHome(mediaErrorReason(e, callModeRef.current))
      }
    })
    return () => off()
  }, [on, setupPeerConnection, emit, resetToHome])

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
      // 通话尚未真正建立时被中断，提示用户原因；通话中正常挂断不打扰
      const wasConnecting = viewRef.current === 'connecting' || viewRef.current === 'waiting'
      cleanup()
      setView('home')
      setRoomId('')
      setSymbolString('')
      setJoinStatus('idle')
      setJoinedSymbol(null)
      roomIdRef.current = ''
      isInitiatorRef.current = false
      if (wasConnecting) setErrorMessage('对方已取消或离开')
    })
    return () => off()
  }, [on, cleanup])

  const handleInvite = useCallback(async (newRoomId: string, symbols: string) => {
    // 预授权麦克风：在用户的点击手势中弹权限提示，避免对方加入后才弹、用户已离开页面而被拒。
    // 模式（音频/视频）由接受方决定，此处先要音频；若对方选视频，进入握手时再请求摄像头。
    setErrorMessage(null)
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (e) {
      console.error('[preflight] mic error', e)
      setErrorMessage(mediaErrorReason(e, 'audio'))
      return
    }
    storeLocalStream(stream)

    const pubKey = crypto.generateKeys()
    roomIdRef.current = newRoomId
    isInitiatorRef.current = true
    setIsInitiator(true)
    setRoomId(newRoomId)
    setSymbolString(symbols)
    emit('create-room', { roomId: newRoomId, symbols, pubKeyA: pubKey })
    setView('waiting')
  }, [crypto, emit, storeLocalStream])

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
    // 先同步设置 ref，再异步更新 state——保证 offer 到达时能读到正确模式
    callModeRef.current = mode
    setCallMode(mode)
    isInitiatorRef.current = false
    const pubKey = crypto.publicKeyB64.current
    if (!pubKey) return

    // 预授权：在用户点击手势中拿权限，权限被拒就停在 join 视图给出可操作的提示，
    // 不发 join-room，发起方不会被卷入。
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: mode === 'video' })
    } catch (e) {
      console.error('[preflight] media error', e)
      setErrorMessage(mediaErrorReason(e, mode))
      return
    }
    storeLocalStream(stream)

    emit('join-room', { roomId: roomIdRef.current, pubKeyB: pubKey, callMode: mode })
    // 立即切到"正在建立连接"视图：点击有反馈、按钮不会被重复触发
    setView('connecting')
  }, [crypto, emit, storeLocalStream])

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
              {errorMessage && (
                <div className="flex items-start gap-2 text-xs bg-destructive/10 border border-destructive/30 text-destructive rounded-lg px-3 py-2">
                  <span className="flex-1">{errorMessage}</span>
                  <button
                    onClick={() => setErrorMessage(null)}
                    className="text-destructive/70 hover:text-destructive"
                    aria-label="关闭提示"
                  >
                    ✕
                  </button>
                </div>
              )}
              <div className="text-xs text-muted-foreground bg-muted/40 rounded-lg px-4 py-3 space-y-1">
                <p className="font-medium text-foreground mb-1">使用流程</p>
                <p>① 发起方：选好暗语标志（颜色/形状/数量含义事先与对方约好）→ 发起邀请</p>
                <p>② 发起方：把 8 位房间码发给对方</p>
                <p>③ 接受方：点「加入通话」→ 输入房间码 → 识别标志 → 接听</p>
              </div>
              <InvitePanel
                onInvite={handleInvite}
                onJoinMode={() => { setErrorMessage(null); setView('join') }}
                connected={connected}
              />
            </div>
          )}

          {view === 'connecting' && (
            <div className="space-y-6 text-center">
              <div className="space-y-2">
                <div className="text-xs text-muted-foreground uppercase tracking-widest">
                  {isInitiatorRef.current ? '对方已加入' : '已接听'}
                </div>
                <div className="text-lg font-medium">正在建立加密通话…</div>
              </div>
              <div className="flex items-center justify-center gap-2 py-4">
                <div className="w-2 h-2 bg-primary rounded-full animate-pulse" />
                <div className="w-2 h-2 bg-primary rounded-full animate-pulse [animation-delay:150ms]" />
                <div className="w-2 h-2 bg-primary rounded-full animate-pulse [animation-delay:300ms]" />
              </div>
              <p className="text-xs text-muted-foreground">
                {callMode === 'video' ? '请允许浏览器使用麦克风和摄像头' : '请允许浏览器使用麦克风'}
              </p>
              <button
                onClick={() => resetToHome()}
                className="text-sm text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
              >
                取消
              </button>
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
            <div className="space-y-4">
              {errorMessage && (
                <div className="flex items-start gap-2 text-xs bg-destructive/10 border border-destructive/30 text-destructive rounded-lg px-3 py-2">
                  <span className="flex-1">{errorMessage}</span>
                  <button
                    onClick={() => setErrorMessage(null)}
                    className="text-destructive/70 hover:text-destructive"
                    aria-label="关闭提示"
                  >
                    ✕
                  </button>
                </div>
              )}
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
            </div>
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
