import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { animate, useReducedMotion } from 'motion/react'
import { COMPOSER_GROW } from '../motion'

/**
 * The composer card's height range on the desktop, border to border with the toolbar
 * and the image row included (2026-10-18; DMs and the project thread joined
 * 2026-10-19). `session` is the box at the foot of a chat or Session, `stage` the one
 * centred on a new chat's page before the first message. A `rest` of 0 leaves the
 * resting height to the editor's own minimum, which keeps the stage's start as it was.
 */
export const COMPOSER_CARD_HEIGHTS = {
  session: { rest: 100, max: 220, maxWithImage: 300 },
  stage: { rest: 0, max: 420, maxWithImage: 500 },
} as const

export type ComposerCardHeights = keyof typeof COMPOSER_CARD_HEIGHTS

/**
 * Eases the draft's scroller to the height of the text it holds, so the card grows a
 * line at a time without stepping. The card itself stays `auto` between its min and max
 * height: its min stretches the scroller, its max squeezes it, and the text scrolls once
 * squeezed. The max-height eases here too, on the same clock and curve as the image row
 * that changes it, so the two move as one and the card never has to be measured. While
 * the scroller grows towards a height the whole draft fits in, the text stays pinned to
 * the top: the growing box uncovers the new line, rather than the line being scrolled up
 * into view and back down.
 *
 * Needs a `[data-composer-scroller]` in the card and a `[data-composer-editor]` in it
 * at its natural height. Owns the card's inline max-height; `max` undefined clears it.
 */
export function useComposerCardHeight(card: RefObject<HTMLDivElement | null>, max: number | undefined, draftKey: string | undefined) {
  const reduceMotion = useReducedMotion() === true
  const running = useRef<{ to: number; stop: () => void } | null>(null)
  const easingMax = useRef<{ stop: () => void } | null>(null)
  const sizedMax = useRef(false)
  const fittedKey = useRef(draftKey)
  // Opening another draft, like the first fit, never animates. The incoming text reaches
  // the editor's DOM only after the render that changed the key, so the switch stays
  // pending until the observer's next call, which sees that text.
  const switchPending = useRef(true)

  // A layout effect, so a switched draft is fitted before the frame that shows it.
  useLayoutEffect(() => {
    const box = card.current
    if (box === null) return
    easingMax.current?.stop()
    easingMax.current = null
    if (max === undefined) {
      // Only a max this hook set is taken back; a card it never sized is left alone.
      if (sizedMax.current) box.style.maxHeight = ''
      sizedMax.current = false
      return
    }
    const scroller = box.querySelector<HTMLElement>('[data-composer-scroller]')
    const editor = scroller?.querySelector('[data-composer-editor]')
    if (scroller === null || editor == null) return
    if (fittedKey.current !== draftKey) {
      fittedKey.current = draftKey
      switchPending.current = true
    }
    const shownMax = sizedMax.current ? parseFloat(box.style.maxHeight) : Number.NaN
    sizedMax.current = true
    if (switchPending.current || reduceMotion || Number.isNaN(shownMax)) box.style.maxHeight = `${max}px`
    else if (Math.abs(shownMax - max) >= 0.5) {
      easingMax.current = animate(shownMax, max, {
        ...COMPOSER_GROW,
        onUpdate: (height) => {
          box.style.maxHeight = `${height}px`
        },
      })
    }
    const fit = () => {
      const to = editor.getBoundingClientRect().height
      if (switchPending.current) {
        running.current?.stop()
        running.current = null
        scroller.style.height = `${to}px`
        return
      }
      const target = running.current?.to ?? parseFloat(scroller.style.height)
      // The card changing around an unchanged draft (an image row, the max) is not a fit.
      if (Math.abs(target - to) < 0.5) return
      running.current?.stop()
      running.current = null
      // Starts from what shows, which the card's min may stretch and its max squeeze. The
      // scroller is content-box, so its reach into the card's padding is not the draft's.
      const from = scroller.getBoundingClientRect().height - parseFloat(getComputedStyle(scroller).paddingTop)
      if (reduceMotion || Math.abs(to - from) < 0.5) {
        scroller.style.height = `${to}px`
        return
      }
      // What the draft may have at the card's max, beside everything else in the card.
      const room = max - (box.getBoundingClientRect().height - from)
      const pinTop = to > from && to <= room + 0.5
      if (pinTop) scroller.scrollTop = 0
      const controls = animate(from, to, {
        ...COMPOSER_GROW,
        onUpdate: (height) => {
          scroller.style.height = `${height}px`
          if (pinTop) scroller.scrollTop = 0
        },
        onComplete: () => {
          running.current = null
        },
      })
      running.current = { to, stop: () => controls.stop() }
    }
    // The scroller shrinks under a caret that was in view when the card loses room it
    // already used (an image taken away at the max), so the caret is put back in view.
    let lastRoom = scroller.clientHeight
    const keepCaret = () => {
      const room = scroller.clientHeight
      const lost = lastRoom - room
      lastRoom = room
      const selection = getSelection()
      if (lost < 0.5 || selection === null || selection.rangeCount === 0 || !selection.isCollapsed || !editor.contains(selection.anchorNode)) return
      const range = selection.getRangeAt(0)
      // A caret on an empty line has no box of its own; the line it sits on does.
      let caret = range.getBoundingClientRect()
      if (caret.height === 0) {
        const line = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
        if (line !== null) caret = line.getBoundingClientRect()
      }
      const bottom = scroller.getBoundingClientRect().bottom
      // Only a caret the lost room just covered; one already scrolled away from stays put.
      if (caret.bottom > bottom && caret.bottom <= bottom + lost + 0.5) scroller.scrollTop += caret.bottom - bottom
    }
    fit()
    const observer = new ResizeObserver(() => {
      fit()
      switchPending.current = false
      keepCaret()
    })
    observer.observe(editor)
    observer.observe(scroller)
    return () => {
      observer.disconnect()
      running.current?.stop()
      running.current = null
    }
  }, [card, max, draftKey, reduceMotion])

  useLayoutEffect(() => () => easingMax.current?.stop(), [])
}

/** The one-row card at rest: the round controls with the card's padding around them. */
const COMPOSER_ROW_HEIGHT = 48

/**
 * Whether a one-row composer stands in its row: plus, text and send on one line, the
 * way a DM's composer rests. It stacks into the usual card, text above its controls,
 * once the draft is more than one plain line (`plain` false, or the line wrapped), and
 * stays stacked until the draft is `blank`: the stacked text is wider, so a draft that
 * fell back at once would land in the row it just outgrew. The switch eases the card's
 * height on the clock the draft grows by.
 *
 * Needs the card's `[data-composer-scroller]` and `[data-composer-editor]`. Owns the
 * card's inline min-height (`rest` while stacked, 0 for none), and its height and
 * overflow while it eases.
 */
export function useComposerRow(card: RefObject<HTMLDivElement | null>, enabled: boolean, plain: boolean, blank: boolean, rest: number, draftKey: string | undefined): boolean {
  const reduceMotion = useReducedMotion() === true
  const [stacked, setStacked] = useState(!plain)
  const [stackedKey, setStackedKey] = useState(draftKey)
  if (stackedKey !== draftKey) {
    setStackedKey(draftKey)
    setStacked(!plain)
  } else if (stacked ? blank && plain : !plain) setStacked(!stacked)
  const row = enabled && plain && !stacked

  useLayoutEffect(() => {
    if (!row) return
    const editor = card.current?.querySelector('[data-composer-editor]')
    if (editor == null) return
    const observer = new ResizeObserver(() => {
      const style = getComputedStyle(editor)
      const line = parseFloat(style.lineHeight)
      const oneLine = line + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
      // Before the frame paints, so the row never shows with two lines in it.
      if (editor.getBoundingClientRect().height > oneLine + line / 2) flushSync(() => setStacked(true))
    })
    observer.observe(editor)
    return () => observer.disconnect()
  }, [card, row, draftKey])

  // The height that last showed, which is where a switch eases from.
  const shown = useRef<number | null>(null)
  useLayoutEffect(() => {
    const box = card.current
    if (box === null || !enabled) return
    const observer = new ResizeObserver(() => {
      shown.current = box.getBoundingClientRect().height
    })
    observer.observe(box)
    return () => observer.disconnect()
  }, [card, enabled])

  const stood = useRef({ row, draftKey })
  const easing = useRef<{ stop: () => void } | null>(null)
  useLayoutEffect(() => {
    const box = card.current
    // Opening another draft is not a switch of this one, and never animates.
    const switched = stood.current.row !== row && stood.current.draftKey === draftKey
    stood.current = { row, draftKey }
    if (box === null || !enabled) return
    const min = row ? COMPOSER_ROW_HEIGHT : rest
    const settle = () => {
      easing.current?.stop()
      easing.current = null
      box.style.height = ''
      box.style.overflow = ''
      box.style.minHeight = min > 0 ? `${min}px` : ''
    }
    settle()
    const from = shown.current
    const scroller = box.querySelector<HTMLElement>('[data-composer-scroller]')
    const editor = scroller?.querySelector('[data-composer-editor]')
    if (!switched || reduceMotion || from === null || scroller == null || editor == null) return
    // The draft's box goes straight to the text it holds, so the card is measured at the
    // height it will keep and eases there as one move.
    scroller.style.height = `${editor.getBoundingClientRect().height}px`
    const to = box.getBoundingClientRect().height
    if (Math.abs(to - from) < 0.5) return
    // The height alone leads while it eases: the min would hold the card at its end
    // height, and the stacked controls do not fit the row's height it starts from.
    box.style.minHeight = '0'
    box.style.height = `${from}px`
    box.style.overflow = 'hidden'
    const controls = animate(from, to, {
      ...COMPOSER_GROW,
      onUpdate: (height) => {
        box.style.height = `${height}px`
      },
      onComplete: settle,
    })
    easing.current = { stop: () => controls.stop() }
  }, [card, enabled, row, rest, draftKey, reduceMotion])

  // Lets go of everything it set once the card stops being a one-row card, as when the
  // window narrows to touch width, and when it unmounts.
  useLayoutEffect(() => {
    const box = card.current
    if (box === null || !enabled) return
    return () => {
      easing.current?.stop()
      easing.current = null
      box.style.height = ''
      box.style.overflow = ''
      box.style.minHeight = ''
    }
  }, [card, enabled])

  return row
}
