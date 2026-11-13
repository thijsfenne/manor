import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProviderMark } from '../src/components/ProviderMark'

describe('ProviderMark', () => {
  it('renders the Cursor cube at the requested size', () => {
    const html = renderToStaticMarkup(<ProviderMark driver="cursor" size={14} />)

    expect(html).toContain('data-provider-mark="cursor"')
    expect(html).toContain('width="14"')
    expect(html).toContain('height="14"')
  })
})
