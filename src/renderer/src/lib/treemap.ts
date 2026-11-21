function worstRatio(row: number[], sum: number, side: number): number {
  if (sum <= 0 || side <= 0) return Number.POSITIVE_INFINITY
  const thickness = sum / side
  let worst = 0
  for (const value of row) {
    const length = value / thickness
    if (length <= 0) continue
    const ratio = Math.max(thickness / length, length / thickness)
    if (ratio > worst) worst = ratio
  }
  return worst
}

/** Squarified treemap: keeps cells close to square so labels stay readable. */
export function squarify(values: number[], width: number, height: number): { x: number; y: number; w: number; h: number }[] {
  const total = values.reduce((sum, value) => sum + value, 0)
  if (total <= 0 || width <= 0 || height <= 0) return []
  const area = width * height
  const scaled = values.map((value) => (value / total) * area)
  const out: { x: number; y: number; w: number; h: number }[] = []
  let cursorX = 0
  let cursorY = 0
  let cursorW = width
  let cursorH = height
  let index = 0

  while (index < scaled.length && cursorW > 0.01 && cursorH > 0.01) {
    const side = Math.min(cursorW, cursorH)
    const row: number[] = []
    let rowSum = 0
    let best = Number.POSITIVE_INFINITY
    let next = index

    while (next < scaled.length) {
      const candidateSum = rowSum + scaled[next]
      const ratio = worstRatio([...row, scaled[next]], candidateSum, side)
      if (row.length === 0 || ratio <= best) {
        row.push(scaled[next])
        rowSum = candidateSum
        best = ratio
        next += 1
      } else break
    }

    const thickness = rowSum / side
    if (cursorW >= cursorH) {
      let offsetY = cursorY
      for (const value of row) {
        const itemHeight = value / Math.max(thickness, 0.0001)
        out.push({ x: cursorX, y: offsetY, w: thickness, h: itemHeight })
        offsetY += itemHeight
      }
      cursorX += thickness
      cursorW -= thickness
    } else {
      let offsetX = cursorX
      for (const value of row) {
        const itemWidth = value / Math.max(thickness, 0.0001)
        out.push({ x: offsetX, y: cursorY, w: itemWidth, h: thickness })
        offsetX += itemWidth
      }
      cursorY += thickness
      cursorH -= thickness
    }
    index = next
  }
  return out
}
