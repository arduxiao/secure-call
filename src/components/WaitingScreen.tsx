'use client'
import { useEffect, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { generateRoomCode } from '@/lib/roomCode'

interface WaitingScreenProps {
  roomId: string
  symbolString: string
  onCancel: () => void
  onEditRoomId: (newRoomId: string) => void
}

const VALID_ROOM_RE = /^[A-Z0-9]{8}$/

export function WaitingScreen({ roomId, symbolString, onCancel, onEditRoomId }: WaitingScreenProps) {
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(roomId)
  const [editError, setEditError] = useState<string | null>(null)

  // 外部 roomId 变化（例如保存成功后回写）时，同步草稿，避免显示陈旧值
  useEffect(() => {
    if (!editing) setDraft(roomId)
  }, [roomId, editing])

  const copyRoomId = async () => {
    try {
      await navigator.clipboard.writeText(roomId)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
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

  const enterEdit = () => {
    setDraft(roomId)
    setEditError(null)
    setEditing(true)
  }

  const cancelEdit = () => {
    setDraft(roomId)
    setEditError(null)
    setEditing(false)
  }

  const saveEdit = () => {
    const next = draft.trim().toUpperCase()
    if (!VALID_ROOM_RE.test(next)) {
      setEditError('房间码必须是 8 位字母或数字')
      return
    }
    if (next === roomId) {
      setEditing(false)
      return
    }
    onEditRoomId(next)
    setEditing(false)
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
            <p className="text-xs text-muted-foreground mb-2">
              房间码{editing ? '（自定义 8 位字母或数字）' : '（点击复制后发给对方）'}
            </p>

            {editing ? (
              <div className="space-y-2">
                <Input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value.toUpperCase().slice(0, 8))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveEdit()
                    if (e.key === 'Escape') cancelEdit()
                  }}
                  maxLength={8}
                  className="font-mono text-2xl tracking-[0.3em] text-center h-14"
                />
                {editError && (
                  <p className="text-xs text-destructive text-center">{editError}</p>
                )}
                <div className="grid grid-cols-3 gap-2">
                  <Button onClick={saveEdit}>保存</Button>
                  <Button variant="outline" onClick={cancelEdit}>取消</Button>
                  <Button
                    variant="outline"
                    onClick={() => { setDraft(generateRoomCode()); setEditError(null) }}
                    title="重新随机生成"
                  >
                    🎲 重新生成
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <button
                  onClick={copyRoomId}
                  className="w-full font-mono text-2xl tracking-[0.3em] text-center py-3 bg-muted rounded-lg hover:bg-muted/80 transition-colors"
                >
                  {roomId}
                </button>
                <div className="flex items-center justify-between mt-1">
                  <button
                    onClick={enterEdit}
                    className="text-xs text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
                  >
                    编辑房间码
                  </button>
                  <p className={`text-xs transition-colors ${copied ? 'text-green-500' : 'text-muted-foreground'}`}>
                    {copied ? '✓ 已复制' : '点击复制'}
                  </p>
                </div>
              </>
            )}
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
