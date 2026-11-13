/**
 * Puts text on the clipboard and says whether it landed. Every copy control in Manor
 * goes through here so none of them can quietly do nothing.
 *
 * The async API is the path; the hidden-textarea `execCommand` below is the fallback
 * for the shells that refuse it (a desktop build whose permission handler says no, a
 * non-secure origin), because a copy button that reports failure is still worse than
 * one that copies.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Falls through to the textarea; the API's refusal is not the last word.
  }
  return copyByExecCommand(text)
}

function copyByExecCommand(text: string): boolean {
  const field = document.createElement('textarea')
  field.value = text
  // Off-screen rather than hidden: `display: none` cannot hold a selection, and a
  // visible flash of the note's path in the corner is its own kind of bug.
  field.setAttribute('readonly', '')
  field.style.position = 'fixed'
  field.style.top = '-1000px'
  field.style.opacity = '0'
  document.body.append(field)
  const selection = document.getSelection()
  const previous = selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
  try {
    field.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    field.remove()
    // The user's own selection was on screen a moment ago; put it back.
    if (previous !== null && selection !== null) {
      selection.removeAllRanges()
      selection.addRange(previous)
    }
  }
}
