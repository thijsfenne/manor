import { describe, expect, it } from 'vitest'
import { modalOverflows } from '../src/components/Modal'

describe('modal footer divider', () => {
  it('appears only when modal content has to scroll', () => {
    expect(modalOverflows(701, 700)).toBe(false)
    expect(modalOverflows(702, 700)).toBe(true)
    expect(modalOverflows(500, 700)).toBe(false)
  })
})
