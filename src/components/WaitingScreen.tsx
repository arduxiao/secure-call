'use client'
import { useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

interface WaitingScreenProps {
  roomId: string
  symbolString: string
  onCancel: () => void
}

export function WaitingScreen({ roomId, symbolString, onCancel }: WaitingScreenProps) {
  const [copied, setCopied] = useState(false)

  const copyRoomId = async () => {
    try {
      await navigator.clipboard.writeText(roomId)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // fallback for browsers that block clipboard API
      const el = document.createElement('textarea')
      el.value = roomId
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <div className="text-xs text-muted-foreground uppercase tracking-widest">等待对方加入</div>
        <div className="flex items-center justify-center gap-2">
          <div className="w-2 h-2 bg-primary rounded-full animate-pulse" />
          <div className="w-2 h-2 bg-primary rounded-full animate-pulse [animation-delay:150ms]" />
          <div className="w-2 h-2 bg-primary rounded-full animate-pulse [animation-delay:300ms]" />
        </div>
      </div>

      <Card>
        <CardContent className="pt-6 space-y-4">
          <div>
            <p className="text-xs text-muted-foreground mb-2">房间码（点击复制后发给对方）</p>
            <button
              onClick={copyRoomId}
              className="w-full font-mono text-2xl tracking-[0.3em] text-center py-3 bg-muted rounded-lg hover:bg-muted/80 transition-colors"
            >
              {roomId}
            </button>
            <p className={`text-xs text-center mt-1 transition-colors ${copied ? 'text-green-500' : 'text-muted-foreground'}`}>
              {copied ? '✓ 已复制' : '点击复制'}
            </p>
          </div>

          <div>
            <p className="text-xs text-muted-foreground mb-1">你选择的暗语标志</p>
            <div className="text-4xl text-center py-2">{symbolString}</div>
            <p className="text-xs text-muted-foreground text-center">对方输入房间码后会看到此标志，请确保对方事先知晓含义</p>
          </div>
        </CardContent>
      </Card>

      <Button variant="outline" onClick={onCancel} className="w-full">
        取消邀请
      </Button>
    </div>
  )
}
