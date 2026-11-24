import type { Transition, Variants } from 'motion/react'

/**
 * `--ease-arrive` in `styles.css`, restated as control points because motion/react
 * cannot read a CSS variable. The two are one curve and move together.
 */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const

export const INSTANT: Transition = { duration: 0 }

/**
 * A dropped board column easing the last stretch into its slot. A bounce, not a curve,
 * because Motion's drag settles with inertia: firm enough to arrive with its neighbours,
 * damped enough never to overshoot the slot.
 */
export const COLUMN_SETTLE = { bounceStiffness: 500, bounceDamping: 45 } as const

/**
 * A mark that turns up on a message already read, because the work behind it finished
 * after the answer did (the memory writer's diff). Opacity only and slow enough to
 * register: it is news arriving, not a control responding.
 */
export const LATE_MARK: Transition = { duration: 0.36, ease: EASE_OUT }

/**
 * The active surface travelling between labels in a segmented control, and the
 * selection fill between sidebar and rail rows. Quick, because it answers a click
 * made many times a day: the fill is home before the next one lands.
 */
export const SEGMENTED_SLIDE: Transition = { duration: 0.18, ease: EASE_OUT }

/**
 * A few controls folding open under the button that holds them (a proposal's Options).
 * The same 220ms the CSS `.fold` arrives in, opacity a little ahead so the controls
 * never show half-clipped.
 */
export const DISCLOSURE: Transition = { duration: 0.22, ease: EASE_OUT, opacity: { duration: 0.16 } }
/** The same controls folding shut: the 160ms the CSS `.fold` leaves in. */
export const DISCLOSURE_OUT: Transition = { duration: 0.16, ease: 'easeIn', opacity: { duration: 0.12 } }

/**
 * A Session's card in its project thread trading one shape for the next (proposal, one
 * line, done). Opacity only: the card does not travel, it becomes something else where
 * it stands, and the slower fade lets the eye see that it is the same card.
 */
export const CARD_RESHAPE: Transition = { duration: 0.32, ease: EASE_OUT }

/** The plan ring closing a little further as a step finishes: a progress change, so it travels the whole move on the house curve. */
export const PLAN_FILL: Transition = { duration: 0.4, ease: EASE_OUT }

/** Panel unfold. A little bounce, then it sits. */
export const SPRING_PANEL = { type: 'spring', duration: 0.42, bounce: 0.14 } as const

/**
 * The composer's own travel between the middle of a new chat and the foot of a live
 * one. Short and barely springy: it is a move that says where the box went, and a
 * bounce on something you are about to type into reads as a toy.
 */
export const SPRING_COMPOSER = { type: 'spring', duration: 0.3, bounce: 0.06 } as const

/**
 * The composer card easing to its next height as a line or an image comes or
 * goes. Short, because it answers a keystroke, and on the house curve so most of the
 * distance is covered before the next key lands.
 */
export const COMPOSER_GROW: Transition = { duration: 0.16, ease: EASE_OUT }

/** Chevron flip on a select. */
export const SPRING_CHEVRON = { type: 'spring', duration: 0.4, bounce: 0.3 } as const

/**
 * A menu hanging off the control that opened it, arriving and leaving. See `Popover`.
 * The scale pair and the durations are `transitions.dev`'s dropdown tuning; the curve
 * is the house one. Deliberately no spring: these open under a pointer already on its
 * way to a row, and a sheet still settling when the click lands moved that row.
 *
 * The fill arrives well ahead of the growth, so the card is solid while it is still
 * opening. A sheet that fades for the whole 250ms reads as slow even though it is not.
 */
export const POPOVER_PRE_SCALE = 0.97
export const POPOVER_CLOSING_SCALE = 0.99

/** How far the card starts from where it lands, in px, toward its own trigger. */
export const POPOVER_TRAVEL = 12

/**
 * The one curve in the house that is not `EASE_OUT`, and it earns it. `EASE_OUT` puts
 * 85% of the distance in the first third and spends the rest of the duration creeping
 * the last pixel home, which is right for something that has already arrived and only
 * has to settle. A twelve-pixel travel under it is over before the eye finds it, and
 * what is left reads as a panel that was already there twitching into place. This
 * spreads the distance across the whole move, so the arrival is the thing you see.
 */
export const EASE_TRAVEL = [0.4, 0, 0.2, 1] as const

/**
 * Browser tabs stepping aside for the one being dragged over them. Unhurried and on
 * the travel curve, so a neighbour visibly slides into the gap instead of jumping.
 */
export const TAB_REORDER: Transition = { duration: 0.28, ease: EASE_TRAVEL }

export const POPOVER_IN: Transition = { duration: 0.2, ease: EASE_TRAVEL, opacity: { duration: 0.09 } }
export const POPOVER_OUT: Transition = { duration: 0.15, ease: 'easeIn', opacity: { duration: 0.12 } }

/**
 * Two marks trading places in one slot. `transitions.dev`'s icon swap
 * (09-icon-swap) at its own scale and blur, on the popover's curve and a touch
 * quicker: a 16px mark has less distance to cover than a panel does.
 */
export const ICON_SWAP: Transition = { duration: 0.2, ease: EASE_TRAVEL }
export const ICON_SWAP_GONE = { opacity: 0, scale: 0.25, filter: 'blur(2px)' }
export const ICON_SWAP_REST = { opacity: 1, scale: 1, filter: 'blur(0px)' }

/**
 * A status label whose words change while you are reading them. `transitions.dev`'s
 * text swap (04-text-states-swap) at its own tuning: the old line leaves upward under
 * blur and the new one arrives from below, 150ms each way. The blur is what keeps two
 * short words from reading as a jump cut. Four pixels is a travel, so it rides the travel curve.
 */
export const TEXT_SWAP: Transition = { duration: 0.15, ease: EASE_TRAVEL }
export const TEXT_SWAP_BELOW = { opacity: 0, y: 4, filter: 'blur(2px)' }
export const TEXT_SWAP_REST = { opacity: 1, y: 0, filter: 'blur(0px)' }
export const TEXT_SWAP_ABOVE = { opacity: 0, y: -4, filter: 'blur(2px)' }

/**
 * `--ease-overshoot` in `styles.css`, restated as control points like `EASE_OUT`. The
 * two are one curve and move together.
 */
export const EASE_OVERSHOOT = [0.34, 1.36, 0.64, 1] as const

/**
 * A digit of a live count landing as the number ticks. Only the digits that changed
 * move; they come up from below when the count grows and down from above when it
 * shrinks, and the small overshoot is what makes a ticking total read as counting
 * rather than flickering.
 */
export const DIGIT_POP: Transition = { duration: 0.3, ease: EASE_OVERSHOOT, opacity: { duration: 0.16 } }
export const DIGIT_POP_TRAVEL = 6
export const DIGIT_POP_REST = { opacity: 1, y: 0, filter: 'blur(0px)' }

/**
 * A line the project thread just wrote into one of its files, rising into place under
 * a short blur, one line and no stagger. The row opens its own height on the same
 * move, so the lines under it slide down instead of jumping.
 */
export const LINE_REVEAL: Transition = { duration: 0.32, ease: EASE_TRAVEL, opacity: { duration: 0.2 } }
export const LINE_REVEAL_FROM = { height: 0, opacity: 0, y: 8, filter: 'blur(3px)' }
export const LINE_REVEAL_REST = { height: 'auto', opacity: 1, y: 0, filter: 'blur(0px)' }
/** The line leaving: the settled inbox row's slide aside, its height closing with it. */
export const LINE_SETTLE_OUT = { height: 0, opacity: 0, x: 12, scale: 0.98, transition: { duration: 0.14, ease: 'easeIn' } } as const

export const LIST_VARIANTS: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.035, delayChildren: 0.05 } },
}

export const ITEM_VARIANTS: Variants = {
  hidden: { opacity: 0, y: -6, filter: 'blur(3px)' },
  show: { opacity: 1, y: 0, filter: 'blur(0px)' },
}

/** Nested sidebar list. Same wipe and stagger the beUI submenu uses. */
export const SUBMENU_VARIANTS: Variants = {
  closed: {
    opacity: 0,
    clipPath: 'inset(0 0 100% 0)',
    transition: { duration: 0.14, ease: EASE_OUT, staggerChildren: 0.025, staggerDirection: -1 },
  },
  open: {
    opacity: 1,
    clipPath: 'inset(0 0 0% 0)',
    transition: { duration: 0.2, delayChildren: 0.035, ease: EASE_OUT, staggerChildren: 0.045 },
  },
}

/**
 * The Settled list's unfold. Same wipe, just over half the stagger: its pages run to
 * twenty rows, and at the submenu's pace the last one landed almost a second late.
 */
export const SETTLED_LIST_VARIANTS: Variants = {
  closed: {
    opacity: 0,
    clipPath: 'inset(0 0 100% 0)',
    transition: { duration: 0.14, ease: EASE_OUT, staggerChildren: 0.025, staggerDirection: -1 },
  },
  open: {
    opacity: 1,
    clipPath: 'inset(0 0 0% 0)',
    transition: { duration: 0.2, delayChildren: 0.03, ease: EASE_OUT, staggerChildren: 0.025 },
  },
}

export const SUBMENU_ITEM_VARIANTS: Variants = {
  closed: { opacity: 0, y: -6, filter: 'blur(3px)' },
  open: {
    opacity: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: { duration: 0.18, ease: EASE_OUT },
  },
}

/**
 * A notice dropping in from the top edge of the stage and lifting back out: the
 * provider-update toast and its progress pill. Slower than a popover, because nobody
 * is reaching for it; it arrives on its own and has to be noticed, not raced.
 */
export const TOAST_TRAVEL = 10
export const TOAST_IN: Transition = { duration: 0.32, ease: EASE_TRAVEL, opacity: { duration: 0.18 } }
export const TOAST_OUT: Transition = { duration: 0.22, ease: 'easeIn', opacity: { duration: 0.18 } }
/** How long a done pill stays before it lifts out on its own. */
export const TOAST_VISIBLE_MS = 3500

/**
 * One picture handing over to the next in the image viewer. A short drift in the
 * direction of travel, so next comes in from the right and previous from the left,
 * and a fade that finishes a touch before it so the two never read as doubled.
 */
export const VIEWER_STEP: Transition = { duration: 0.26, ease: EASE_TRAVEL, opacity: { duration: 0.2 } }
export const VIEWER_STEP_TRAVEL = 16

/**
 * A large modal arriving and leaving: the same rise and scale the CSS `.modal-card-in`
 * plays, with a way out, for a modal that stays open long enough to be closed with care
 * (Settings). The scrim fades on the opacity timing alone.
 */
export const MODAL_IN: Transition = { duration: 0.19, ease: EASE_OUT, opacity: { duration: 0.13 } }
export const MODAL_OUT: Transition = { duration: 0.14, ease: 'easeIn', opacity: { duration: 0.12 } }
export const MODAL_CARD_AWAY = { opacity: 0, y: 8, scale: 0.97 }
export const MODAL_CARD_REST = { opacity: 1, y: 0, scale: 1 }
