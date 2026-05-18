'use client'
import { useRef, useEffect, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'

interface CallScreenProps {
  localStream: MediaStream | null
  remoteStream: MediaStream | null
  hasVideo: boolean
  onHangup: () => void
}

export function CallScreen({ localStream, remoteStream, hasVideo, onHangup }: CallScreenProps) {
  const localVideoRef = useRef<HTMLVideoElement>(null)
  const remoteVideoRef = useRef<HTMLVideoElement>(null)
  const [isMuted, setIsMuted] = useState(false)
  const [isCameraOff, setIsCameraOff] = useState(false)
  const [duration, setDuration] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => setDuration(d => d + 1), 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream
    }
  }, [localStream])

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream
    }
  }, [remoteStream])

  const formatDuration = (seconds: number) => {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0')
    const s = (seconds % 60).toString().padStart(2, '0')
    return `${m}:${s}`
  }

  const toggleMute = useCallback(() => {
    if (localStream) {
      const audioTrack = localStream.getAudioTracks()[0]
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled
        setIsMuted(!audioTrack.enabled)
      }
    }
  }, [localStream])

  const toggleCamera = useCallback(() => {
    if (localStream) {
      const videoTrack = localStream.getVideoTracks()[0]
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled
        setIsCameraOff(!videoTrack.enabled)
      }
    }
  }, [localStream])

  return (
    <div className="fixed inset-0 bg-black flex flex-col">
      {hasVideo ? (
        <>
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            className="w-full h-full object-cover"
          />
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            className="absolute bottom-24 right-4 w-32 h-24 object-cover rounded-lg border border-white/20 shadow-lg"
          />
        </>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <div className="relative">
            <div className="w-24 h-24 rounded-full bg-primary/20 flex items-center justify-center animate-pulse">
              <div className="w-16 h-16 rounded-full bg-primary/40 flex items-center justify-center">
                <span className="text-3xl">🎧</span>
              </div>
            </div>
          </div>
          <p className="text-white/80 text-sm">语音通话中</p>
          <p className="text-white font-mono text-xl">{formatDuration(duration)}</p>
        </div>
      )}

      <div className="absolute bottom-0 left-0 right-0 pb-8 pt-4 bg-gradient-to-t from-black/80 to-transparent">
        {hasVideo && (
          <p className="text-white/60 font-mono text-sm text-center mb-4">{formatDuration(duration)}</p>
        )}
        <div className="flex items-center justify-center gap-4">
          <Button
            variant={isMuted ? 'destructive' : 'secondary'}
            size="icon"
            className="w-12 h-12 rounded-full"
            onClick={toggleMute}
            title={isMuted ? '取消静音' : '静音'}
          >
            {isMuted ? '🔇' : '🎤'}
          </Button>
          {hasVideo && (
            <Button
              variant={isCameraOff ? 'destructive' : 'secondary'}
              size="icon"
              className="w-12 h-12 rounded-full"
              onClick={toggleCamera}
              title={isCameraOff ? '开启摄像头' : '关闭摄像头'}
            >
              {isCameraOff ? '📷' : '📹'}
            </Button>
          )}
          <Button
            variant="destructive"
            size="icon"
            className="w-14 h-14 rounded-full"
            onClick={onHangup}
            title="挂断"
          >
            📞
          </Button>
        </div>
      </div>
    </div>
  )
}
