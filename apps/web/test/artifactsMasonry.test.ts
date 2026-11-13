import type { MyMindArtifact } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { artifactColumns, columnsFor } from '../src/components/artifacts/masonry'

const artifact = (id: string, height: number): MyMindArtifact => ({
  id,
  title: `Artifact ${id}`,
  kind: 'image',
  imageUrl: `https://example.com/${id}.png`,
  imageWidth: 400,
  imageHeight: height,
  tags: [],
  spaces: [],
  created: '2026-08-20T10:00:00.000Z',
  bumped: '2026-08-20T10:00:00.000Z',
})

const page = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, index) => artifact(`o${from + index}`, 200 + ((from + index) % 5) * 160))

describe('artifact masonry', () => {
  it('leaves every card where it was when the next page arrives', () => {
    const first = page(0, 60)
    const before = artifactColumns(first, 4).map((column) => column.map((item) => item.id))
    const after = artifactColumns([...first, ...page(60, 120)], 4).map((column) =>
      column.map((item) => item.id),
    )

    // Every column keeps its earlier run as a prefix: growth only ever appends.
    for (const [index, column] of before.entries()) {
      expect(after[index]?.slice(0, column.length)).toEqual(column)
    }
    expect(after.flat()).toHaveLength(120)
  })

  it('spreads a page rather than stacking it into the first column', () => {
    const columns = artifactColumns(page(0, 40), 4)
    for (const column of columns) expect(column.length).toBeGreaterThan(4)
  })

  it('asks for more columns as the grid gets wider, and never fewer than two', () => {
    expect(columnsFor(0)).toBe(4)
    expect(columnsFor(320)).toBe(2)
    expect(columnsFor(1_080)).toBe(4)
    expect(columnsFor(3_000)).toBe(6)
  })
})
