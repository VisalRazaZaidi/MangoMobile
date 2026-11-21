import test from 'node:test'
import assert from 'node:assert/strict'
import { squarify } from '../src/renderer/src/lib/treemap'

test('treemap fills real container dimensions with proportional non-overlapping rectangles', () => {
  const values = [19600, 4700, 3900, 702, 410, 176, 28]
  for (const [width, height] of [[420, 280], [800, 320], [1200, 340]]) {
    const boxes = squarify(values, width, height)
    assert.equal(boxes.length, values.length)
    const total = values.reduce((a, b) => a + b, 0)
    boxes.forEach((box, i) => {
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.w <= width + 0.001 && box.y + box.h <= height + 0.001)
      assert.ok(Math.abs(box.w * box.h / (width * height) - values[i] / total) < 0.00001)
      for (const other of boxes.slice(i + 1)) {
        assert.ok(Math.min(box.x + box.w, other.x + other.w) - Math.max(box.x, other.x) < 0.001 ||
          Math.min(box.y + box.h, other.y + other.h) - Math.max(box.y, other.y) < 0.001)
      }
    })
  }
})

test('treemap handles empty or unmeasured containers', () => {
  assert.deepEqual(squarify([], 600, 300), [])
  assert.deepEqual(squarify([1], 0, 300), [])
})
