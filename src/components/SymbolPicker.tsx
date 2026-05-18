'use client'
import { Button } from '@/components/ui/button'
import { SHAPES, COLORS, COUNTS, buildSymbolString, Shape, Color, Count, SymbolSelection } from '@/lib/symbols'

interface SymbolPickerProps {
  value: SymbolSelection
  onChange: (selection: SymbolSelection) => void
}

export function SymbolPicker({ value, onChange }: SymbolPickerProps) {
  const symbolString = buildSymbolString(value.shape, value.color, value.count)

  return (
    <div className="space-y-4">
      <div className="text-center py-4">
        <div className="text-5xl font-mono tracking-widest">{symbolString}</div>
      </div>

      <div>
        <p className="text-xs text-muted-foreground mb-2 uppercase tracking-wide">形状</p>
        <div className="flex gap-2 flex-wrap">
          {SHAPES.map(shape => (
            <Button
              key={shape}
              variant={value.shape === shape ? 'default' : 'outline'}
              size="sm"
              className="text-lg w-10 h-10 p-0"
              onClick={() => onChange({ ...value, shape })}
            >
              {shape}
            </Button>
          ))}
        </div>
      </div>

      <div>
        <p className="text-xs text-muted-foreground mb-2 uppercase tracking-wide">颜色</p>
        <div className="flex gap-2 flex-wrap">
          {COLORS.map(color => (
            <Button
              key={color}
              variant={value.color === color ? 'default' : 'outline'}
              size="sm"
              className="text-lg w-10 h-10 p-0"
              onClick={() => onChange({ ...value, color })}
            >
              {color}
            </Button>
          ))}
        </div>
      </div>

      <div>
        <p className="text-xs text-muted-foreground mb-2 uppercase tracking-wide">数量</p>
        <div className="flex gap-2">
          {COUNTS.map(count => (
            <Button
              key={count}
              variant={value.count === count ? 'default' : 'outline'}
              size="sm"
              className="w-10 h-10 p-0"
              onClick={() => onChange({ ...value, count })}
            >
              {count}
            </Button>
          ))}
        </div>
      </div>
    </div>
  )
}
