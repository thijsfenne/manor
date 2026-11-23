import { useEffect, useState } from 'react'
import { Cancel01Icon, Link01Icon, LinkOffIcon, Rotate01Icon } from '@hugeicons/core-free-icons'
import type { BrowserDeviceViewport } from '@manor/contracts'
import { IconButton } from './ui/IconButton'
import { Select } from './ui/Select'

/** What the device toolbar opens at, and its Desktop preset. */
export const DESKTOP_VIEWPORT = { width: 1440, height: 900 } as const

const PRESETS = [
  { value: 'responsive', label: 'Responsive', width: 0, height: 0 },
  { value: 'mobile', label: 'Mobile', width: 390, height: 844 },
  { value: 'tablet', label: 'Tablet', width: 768, height: 1024 },
  { value: 'desktop', label: 'Desktop', ...DESKTOP_VIEWPORT },
] as const

export function BrowserDeviceToolbar({ viewport, disabled, onChange, onError }: {
  viewport: BrowserDeviceViewport
  disabled: boolean
  onChange(viewport: BrowserDeviceViewport | null): void
  onError(message: string): void
}) {
  const [width, setWidth] = useState(String(viewport.width))
  const [height, setHeight] = useState(String(viewport.height))
  const [linked, setLinked] = useState(false)
  const [custom, setCustom] = useState(false)
  useEffect(() => { setWidth(String(viewport.width)); setHeight(String(viewport.height)) }, [viewport.width, viewport.height])
  const preset = custom ? 'responsive' : PRESETS.find((option) => option.width === viewport.width && option.height === viewport.height)?.value ?? 'responsive'
  const reset = () => { setWidth(String(viewport.width)); setHeight(String(viewport.height)) }
  const commit = (dimension: 'width' | 'height') => {
    if (disabled) return
    let nextWidth = Number(width), nextHeight = Number(height)
    if (linked) {
      if (dimension === 'width') nextHeight = Math.round(nextWidth * viewport.height / viewport.width)
      else nextWidth = Math.round(nextHeight * viewport.width / viewport.height)
    }
    if (![nextWidth, nextHeight].every((value) => Number.isInteger(value) && value >= 100 && value <= 3840)) {
      onError('Enter whole-number dimensions between 100 and 3840 pixels.')
      reset()
      return
    }
    setCustom(true)
    if (nextWidth !== viewport.width || nextHeight !== viewport.height) onChange({ width: nextWidth, height: nextHeight })
  }
  return (
    <div aria-label="Device toolbar" className="flex min-w-0 flex-wrap items-center gap-1 border-t border-line px-3 py-2 text-meta text-muted">
      <span className="mr-1">Dimensions</span>
      <div className="w-36 min-w-0 flex-none">
      <Select label="Device preset" value={preset} options={PRESETS} disabled={disabled}
        onChange={(value) => {
          setCustom(value === 'responsive')
          const next = PRESETS.find((option) => option.value === value)
          if (next && next.value !== 'responsive') onChange({ width: next.width, height: next.height })
        }} />
      </div>
      {(['width', 'height'] as const).map((dimension, index) => (
        <span key={dimension} className="flex items-center gap-1">
          {index === 1 ? <span aria-hidden="true">×</span> : null}
          <input type="number" inputMode="numeric" min={100} max={3840} step={1}
            aria-label={`Viewport ${dimension}`} value={dimension === 'width' ? width : height} disabled={disabled}
            className="w-16 rounded-button border border-line bg-field px-2 py-1.5 text-label text-text disabled:opacity-40"
            onChange={(event) => (dimension === 'width' ? setWidth : setHeight)(event.target.value)}
            onBlur={() => commit(dimension)} onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
              if (event.key === 'Escape') { event.preventDefault(); reset() }
            }} />
        </span>
      ))}
      <IconButton icon={linked ? Link01Icon : LinkOffIcon} label="Lock aspect ratio" aria-pressed={linked}
        selected={linked} disabled={disabled} onClick={() => setLinked((value) => !value)} />
      <IconButton icon={Rotate01Icon} label="Rotate viewport" disabled={disabled}
        onClick={() => onChange({ width: viewport.height, height: viewport.width })} />
      <IconButton icon={Cancel01Icon} label="Close device toolbar" className="ml-auto" disabled={disabled}
        onClick={() => onChange(null)} />
    </div>
  )
}
