export const PHONE_LAYOUT_MAX_WIDTH = 600

/** Phone is a width mode, never a device guess. Landscape is deliberately outside v1. */
export function isPhoneLayout(viewportWidth: number): boolean {
  return viewportWidth <= PHONE_LAYOUT_MAX_WIDTH
}
