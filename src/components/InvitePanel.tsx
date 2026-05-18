'use client'
import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { SymbolPicker } from './SymbolPicker'
import { SymbolSelection, buildSymbolString } from '@/lib/symbols'
import { generateRoomCode } from '@/lib/roomCode'

interface InvitePanelProps {
  onInvite: (roomId: string, symbolString: string) => void
  onJoinMode: () => void
}

export function InvitePanel({ onInvite, onJoinMode }: InvitePanelProps) {
  const [symbols, setSymbols] = useState<SymbolSelection>({
    shape: '△',
    color: '🟢',
    count: 1,
  })

  const handleInvite = () => {
    const roomId = generateRoomCode()
    const symbolString = buildSymbolString(symbols.shape, symbols.color, symbols.count)
    onInvite(roomId, symbolString)
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">选择暗语标志</CardTitle>
        </CardHeader>
        <CardContent>
          <SymbolPicker value={symbols} onChange={setSymbols} />
        </CardContent>
      </Card>

      <Button onClick={handleInvite} className="w-full" size="lg">
        发起邀请
      </Button>

      <div className="text-center">
        <button
          onClick={onJoinMode}
          className="text-sm text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
        >
          我有房间码，加入通话
        </button>
      </div>
    </div>
  )
}
