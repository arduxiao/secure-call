'use client'
import { useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface JoinPanelProps {
  onLookup: (roomId: string) => void
  onAcceptAudio: () => void
  onAcceptVideo: () => void
  onReject: () => void
  onBack: () => void
  symbolString: string | null
  status: 'idle' | 'looking' | 'found' | 'not-found'
  connected: boolean
}

export function JoinPanel({
  onLookup,
  onAcceptAudio,
  onAcceptVideo,
  onReject,
  onBack,
  symbolString,
  status,
  connected,
}: JoinPanelProps) {
  const [roomId, setRoomId] = useState('')

  const handleLookup = () => {
    if (roomId.trim().length >= 6) {
      onLookup(roomId.trim().toUpperCase())
    }
  }

  return (
    <div className="space-y-6">
      {!connected && (
        <p className="text-xs text-amber-500 text-center animate-pulse">正在连接服务器…</p>
      )}

      <div className="space-y-3">
        <div className="flex gap-2">
          <Input
            placeholder="输入房间码"
            value={roomId}
            onChange={e => setRoomId(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && handleLookup()}
            className="font-mono tracking-widest text-center text-lg"
            maxLength={8}
            disabled={status === 'looking'}
          />
          <Button
            onClick={handleLookup}
            disabled={roomId.length < 6 || status === 'looking' || !connected}
          >
            {status === 'looking' ? '查询中…' : '查询'}
          </Button>
        </div>

        {status === 'not-found' && (
          <p className="text-sm text-destructive text-center">房间不存在或已过期</p>
        )}
      </div>

      {status === 'found' && symbolString && (
        <Card className="border-primary/50">
          <CardContent className="pt-6 space-y-6">
            <div className="text-center space-y-2">
              <p className="text-xs text-muted-foreground uppercase tracking-widest">对方的暗语标志</p>
              <div className="text-6xl py-4">{symbolString}</div>
              <p className="text-sm text-muted-foreground">根据约定识别此标志后决定是否接听</p>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <Button variant="outline" onClick={onAcceptAudio} className="flex-col h-auto py-3 gap-1">
                <span className="text-lg">🎧</span>
                <span className="text-xs">仅音频</span>
              </Button>
              <Button onClick={onAcceptVideo} className="flex-col h-auto py-3 gap-1">
                <span className="text-lg">📹</span>
                <span className="text-xs">视频通话</span>
              </Button>
              <Button variant="destructive" onClick={onReject} className="flex-col h-auto py-3 gap-1">
                <span className="text-lg">✕</span>
                <span className="text-xs">拒绝</span>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <button
        onClick={onBack}
        className="text-sm text-muted-foreground hover:text-foreground underline-offset-4 hover:underline w-full text-center"
      >
        返回
      </button>
    </div>
  )
}
