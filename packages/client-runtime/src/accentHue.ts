const linear = (channel: number) =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4

/**
 * A persona's accent as an OKLCh hue in degrees, which is the one number a
 * blobatar takes to wear her colour. Undefined for anything that is not a hex,
 * because a few call sites hand an avatar a CSS variable rather than a colour;
 * the blobatar then hues itself off the name, which is its own default and a
 * better answer than a hue derived from a parse failure.
 *
 * Hue only, deliberately. Lightness and chroma are the library's authored
 * constants, and they are what make a roster of blobatars look like one set
 * rather than eight unrelated shapes; handing it a full palette override would
 * also drop the eye's 4.5:1 contrast floor, which is enforced per hue and not
 * per colour we pass in. So the accent picks the hue and the library keeps the
 * rest.
 *
 * OKLCh rather than HSL because that is the space the palette is built in: an
 * HSL hue lands somewhere else entirely once the ramp resolves, most visibly in
 * the blues. Verified against the library's own ramp, which round-trips to
 * within half a degree.
 */
export function accentHue(color: string): number | undefined {
  const typed = color.trim()
  const halves = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(typed)
  const hex = halves
    ? `#${halves[1]}${halves[1]}${halves[2]}${halves[2]}${halves[3]}${halves[3]}`
    : typed
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return undefined
  const channel = (at: number) => linear(parseInt(hex.slice(at + 1, at + 3), 16) / 255)
  const red = channel(0)
  const green = channel(2)
  const blue = channel(4)
  // sRGB to OKLab, Ottosson's matrices. The cube roots are the LMS step; only the
  // two chromatic axes are kept, because lightness is not ours to pass on.
  const long = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue)
  const medium = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue)
  const short = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue)
  const greenRed = 1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short
  const blueYellow = 0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short
  return ((Math.atan2(blueYellow, greenRed) * 180) / Math.PI + 360) % 360
}
