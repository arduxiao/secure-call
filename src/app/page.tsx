'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { InvitePanel } from '@/components/InvitePanel'
import { WaitingScreen } from '@/components/WaitingScreen'
import { JoinPanel } from '@/components/JoinPanel'
import { CallScreen } from '@/components/CallScreen'
import { useSignaling } from '@/hooks/useSignaling'
import { useCrypto } from '@/hooks/useCrypto'
import { encrypt, decrypt } from '@/lib/crypto'
import { computeSAS } from '@/lib/sas'
import type { CallMode } from '@/lib/protocol'
import { Lock } from 'lucide-react'

type View = 'home' | 'waiting' | 'join' | 'verifying' | 'connecting' | 'call'
type JoinStatus = 'idle' | 'looking' | 'found' | 'not-found'

export default function HomePage() {
  const [view, setView] = useState<View>('home')
  const [roomId, setRoomId] = useState('')
  const [symbolString, setSymbolString] = useState('')
  const [joinStatus, setJoinStatus] = useState<JoinStatus>('idle')
  const [joinedSymbol, setJoinedSymbol] = useState<string | null>(null)
  const [callMode, setCallMode] = useState<CallMode>('audio')
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  // SAS（Short Authentication String）双方人工对码状态
  const [sasEmoji, setSasEmoji] = useState<string[] | null>(null)
  const [localFingerprintOK, setLocalFingerprintOK] = useState(false)
  const [peerFingerprintOK, setPeerFingerprintOK] = useState(false)
  // 对端在 verifying 阶段需要核对的暗语（A 看到 B 的，B 看到 A 的）
  const [peerSymbol, setPeerSymbol] = useState<string | null>(null)

  const { emit, on, connected } = useSignaling()
  const crypto = useCrypto()
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null)
  const sharedKeyRef = useRef<Uint8Array | null>(null)
  const roomIdRef = useRef('')
  // 双轨：state 驱动 JSX 渲染，ref 给异步事件处理器同步读。
  // 翻转角色时务必走 setRole 同时更新两边——只动一边就是 N10 的复发风险。
  const [isInitiator, setIsInitiator] = useState(false)
  const isInitiatorRef = useRef(false)
  const setRole = useCallback((next: boolean) => {
    isInitiatorRef.current = next
    setIsInitiator(next)
  }, [])
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
    setSasEmoji(null)
    setLocalFingerprintOK(false)
    setPeerFingerprintOK(false)
    setPeerSymbol(null)
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
    setRole(false)
    if (reason) setErrorMessage(reason)
    if (currentRoomId) emit('hangup', { roomId: currentRoomId })
  }, [cleanup, emit, setRole])

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

  // 发起方在双方 SAS 都已确认后才真正建 PC、采流、发 offer
  const startInitiatorWebRTC = useCallback(async () => {
    if (!sharedKeyRef.current) return
    const resolvedMode = callModeRef.current
    setView('connecting')
    const pc = setupPeerConnection()
    try {
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
      const encrypted = encrypt(JSON.stringify({ type: offer.type, sdp: offer.sdp }), sharedKeyRef.current)
      emit('relay-offer', { roomId: roomIdRef.current, sdp: encrypted })
    } catch (e) {
      console.error('[webrtc] offer error', e)
      resetToHome(mediaErrorReason(e, callModeRef.current))
    }
  }, [setupPeerConnection, storeLocalStream, emit, resetToHome])

  // Initiator: listen for peer-joined — derive key, compute SAS, show verify view
  useEffect(() => {
    const off = on('peer-joined', ({ pubKeyB, callMode: remoteMode, symbolsB }) => {
      if (!crypto.publicKeyB64.current) return
      let shared: Uint8Array
      try {
        shared = crypto.deriveSharedKey(pubKeyB)
      } catch (e) {
        console.error('[verify] bad pubKeyB from peer', e)
        return resetToHome('对端公钥无效，已断开')
      }
      sharedKeyRef.current = shared

      const resolvedMode: CallMode = remoteMode === 'video' ? 'video' : 'audio'
      callModeRef.current = resolvedMode
      setCallMode(resolvedMode)
      setSasEmoji(computeSAS(shared))
      setLocalFingerprintOK(false)
      setPeerFingerprintOK(false)
      setPeerSymbol(symbolsB)        // A 在 verifying 阶段核对的暗语
      setView('verifying')
    })
    return () => off()
  }, [on, crypto, resetToHome])

  // Acceptor: listen for offer
  useEffect(() => {
    const off = on('offer', async ({ sdp: encryptedSdp }) => {
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
    const off = on('answer', async ({ sdp: encryptedSdp }) => {
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
    const off = on('ice-candidate', async ({ candidate: encryptedCandidate }) => {
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

  // Listen for the remote SAS confirmation
  useEffect(() => {
    const off = on('peer-verify-confirmed', () => {
      setPeerFingerprintOK(true)
    })
    return () => off()
  }, [on])

  // Honest behaviour when the signalling socket drops mid-handshake:
  //   • waiting / verifying / connecting views NEED the relay → reset to home
  //   • call view is media-only at this point (ICE done) → leave alone
  //   • home / join views → nothing to do
  // Skips the very first render where `connected` is false simply because the
  // socket hasn't finished connecting yet.
  const hadConnectedRef = useRef(false)
  useEffect(() => {
    if (connected) { hadConnectedRef.current = true; return }
    if (!hadConnectedRef.current) return
    const v = viewRef.current
    if (v === 'waiting' || v === 'verifying' || v === 'connecting') {
      resetToHome('网络连接已断开，请重新发起通话')
    }
  }, [connected, resetToHome])

  // Surface server-side rate-limits and rejections as the same error toast.
  // Without this the user sees a button click that silently does nothing.
  useEffect(() => {
    const offRL = on('rate-limited', ({ event }) => {
      console.warn('[signaling] rate-limited:', event)
      setErrorMessage(`请求过于频繁（${event}），请稍后再试`)
    })
    const offErr = on('error', (payload) => {
      // Server-emitted business errors carry { message: '...' }. Anything else
      // (e.g. socket.io transport-level 'error' with a different shape) is ignored.
      const code = (payload as { message?: string } | undefined)?.message
      if (!code) return
      console.warn('[signaling] server error:', code)
      const human: Record<string, string> = {
        'capacity':       '服务器房间已满，请稍后再试',
        'room-exists':    '该房间码已被占用，请换一个',
        'bad-room-id':    '房间码格式不正确',
        'bad-symbols':    '暗语标志格式不正确',
        'bad-pubkey':     '密钥格式不正确',
      }
      setErrorMessage(human[code] ?? `服务器拒绝请求：${code}`)
    })
    return () => { offRL(); offErr() }
  }, [on])

  // When BOTH sides confirm SAS, initiator starts WebRTC; acceptor just waits for offer
  useEffect(() => {
    if (view !== 'verifying') return
    if (!localFingerprintOK || !peerFingerprintOK) return
    if (isInitiatorRef.current) {
      void startInitiatorWebRTC()
    } else {
      setView('connecting')  // wait for the offer to arrive on the existing listener
    }
  }, [view, localFingerprintOK, peerFingerprintOK, startInitiatorWebRTC])

  const handleConfirmFingerprint = useCallback(() => {
    if (localFingerprintOK) return
    setLocalFingerprintOK(true)
    emit('verify-confirm', { roomId: roomIdRef.current })
  }, [emit, localFingerprintOK])

  const handleRejectFingerprint = useCallback(() => {
    resetToHome('密钥指纹不一致，已挂断')
  }, [resetToHome])

  // Listen for peer hangup
  useEffect(() => {
    const off = on('peer-hung-up', () => {
      // 通话尚未真正建立时被中断，提示用户原因；通话中正常挂断不打扰
      const wasConnecting = viewRef.current === 'connecting' || viewRef.current === 'waiting' || viewRef.current === 'verifying'
      cleanup()
      setView('home')
      setRoomId('')
      setSymbolString('')
      setJoinStatus('idle')
      setJoinedSymbol(null)
      roomIdRef.current = ''
      setRole(false)
      if (wasConnecting) setErrorMessage('对方已取消或离开')
    })
    return () => off()
  }, [on, cleanup, setRole])

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
    setRole(true)
    setRoomId(newRoomId)
    setSymbolString(symbols)
    emit('create-room', { roomId: newRoomId, symbols, pubKeyA: pubKey })
    setView('waiting')
  }, [crypto, emit, storeLocalStream, setRole])

  const handleCancelInvite = useCallback(() => {
    emit('hangup', { roomId: roomIdRef.current })
    cleanup()
    setView('home')
    setRoomId('')
    setSymbolString('')
  }, [emit, cleanup])

  const handleEditRoomId = useCallback((nextRoomId: string) => {
    // 发起方改房间码：先挂断旧房间让服务器删除条目，再用同一对密钥在新 id 上重建房间。
    // 保持密钥不变意味着对方若已经查询过旧码、再用新码查询会得到一致的共享密钥。
    const prev = roomIdRef.current
    const pubKey = crypto.publicKeyB64.current
    if (!prev || !pubKey || nextRoomId === prev) return
    emit('hangup', { roomId: prev })
    roomIdRef.current = nextRoomId
    setRoomId(nextRoomId)
    emit('create-room', { roomId: nextRoomId, symbols: symbolString, pubKeyA: pubKey })
  }, [crypto, emit, symbolString])

  const handleLookup = useCallback((code: string) => {
    setJoinStatus('looking')
    roomIdRef.current = code

    crypto.generateKeys()

    const offInfo = on('room-info', ({ symbols, pubKeyA }) => {
      clearTimeout(timer)
      try {
        const shared = crypto.deriveSharedKey(pubKeyA)
        sharedKeyRef.current = shared
      } catch (e) {
        console.error('[lookup] bad pubKeyA from server', e)
        setJoinStatus('not-found')
        offInfo()
        offNotFound()
        return
      }
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

  const handleAccept = useCallback(async (mode: CallMode, symbolsB: string) => {
    callModeRef.current = mode
    setCallMode(mode)
    setRole(false)
    const pubKey = crypto.publicKeyB64.current
    const shared = sharedKeyRef.current  // 已在 handleLookup 阶段算好
    if (!pubKey || !shared) return

    // 预授权：在用户点击手势中拿权限
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: mode === 'video' })
    } catch (e) {
      console.error('[preflight] media error', e)
      setErrorMessage(mediaErrorReason(e, mode))
      return
    }
    storeLocalStream(stream)

    emit('join-room', { roomId: roomIdRef.current, pubKeyB: pubKey, callMode: mode, symbolsB })
    // 进入 SAS 对码视图：B 已经能算指纹；并把对端（A）的暗语带到这里给 B 核对
    setPeerSymbol(joinedSymbol)
    setSasEmoji(computeSAS(shared))
    setLocalFingerprintOK(false)
    setPeerFingerprintOK(false)
    setView('verifying')
  }, [crypto, emit, storeLocalStream, joinedSymbol, setRole])

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

          {view === 'verifying' && sasEmoji && (
            <div className="space-y-5">
              <div className="text-center">
                <h2 className="text-base font-semibold">核对密钥指纹</h2>
                <p className="text-xs text-muted-foreground mt-1">
                  通过电话/可信通讯软件，与对方口头核对下方 {sasEmoji.length} 个图案是否完全一致。
                </p>
                <p className="text-[11px] text-muted-foreground/80 mt-1">
                  指纹由双方公钥经 ECDH 独立计算得到，是抗中间人的数学证据。<strong>如不一致，必定是中间人攻击，请拒绝。</strong>
                </p>
              </div>

              {/* SAS — primary defense, visually prominent */}
              <div className="rounded-xl border-2 border-primary/40 bg-card py-6 px-3">
                <p className="text-xs text-primary uppercase tracking-widest text-center mb-3">密钥指纹 · 最终防线</p>
                <div className="flex items-center justify-center gap-2 flex-wrap">
                  {sasEmoji.map((e, i) => (
                    <span key={i} className="text-4xl select-all" aria-label={`fingerprint-${i}`}>{e}</span>
                  ))}
                </div>
              </div>

              {/* Symbol — secondary identity hint, server-passthrough — explicitly de-emphasized */}
              {peerSymbol && (
                <div className="rounded-xl border border-dashed border-border bg-muted/30 py-3 px-3 text-center">
                  <p className="text-[11px] text-muted-foreground uppercase tracking-widest mb-1">对方的暗语标志 · 辅助识别</p>
                  <div className="text-3xl py-1">{peerSymbol}</div>
                  <p className="text-[10px] text-muted-foreground/80 mt-1 leading-snug px-2">
                    暗语经服务器中转，恶意服务器可保留原值同时仍 MITM——<br />
                    所以暗语相符不能单独证明安全，最终判断请以上方指纹为准。
                  </p>
                </div>
              )}

              <div className="flex flex-col gap-2">
                {!localFingerprintOK ? (
                  <button
                    onClick={handleConfirmFingerprint}
                    className="w-full py-3 rounded-lg bg-primary text-primary-foreground hover:opacity-90 font-medium"
                  >
                    ✓ 指纹一致，开始通话
                  </button>
                ) : (
                  <div className="w-full py-3 rounded-lg bg-muted text-center text-sm text-muted-foreground">
                    {peerFingerprintOK ? '双方已确认，正在建立通话…' : '等待对方确认…'}
                  </div>
                )}
                <button
                  onClick={handleRejectFingerprint}
                  className="w-full py-2 rounded-lg border border-destructive/40 text-destructive text-sm hover:bg-destructive/10"
                >
                  ✕ 指纹不一致，挂断
                </button>
              </div>
            </div>
          )}

          {view === 'connecting' && (
            <div className="space-y-6 text-center">
              <div className="space-y-2">
                <div className="text-xs text-muted-foreground uppercase tracking-widest">
                  {isInitiator ? '对方已加入' : '已接听'}
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
              onEditRoomId={handleEditRoomId}
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
                onAcceptAudio={(symbolsB) => handleAccept('audio', symbolsB)}
                onAcceptVideo={(symbolsB) => handleAccept('video', symbolsB)}
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
