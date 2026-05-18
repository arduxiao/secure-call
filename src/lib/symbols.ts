export const SHAPES = ['△', '○', '□', '◇', '✦'] as const
export const COLORS = ['🟢', '🟡', '🟠', '🔴'] as const
export const COUNTS = [1, 2, 3] as const

export type Shape = typeof SHAPES[number]
export type Color = typeof COLORS[number]
export type Count = typeof COUNTS[number]

export function buildSymbolString(shape: Shape, color: Color, count: Count): string {
  return `${shape.repeat(count)} ${color}`
}

export interface SymbolSelection {
  shape: Shape
  color: Color
  count: Count
}
