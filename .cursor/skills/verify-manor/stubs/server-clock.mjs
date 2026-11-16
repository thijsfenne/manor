// Preloaded into the spike server by `launch`. The server's `Date.now()` runs behind by
// the number of days in the file `MANOR_VERIFY_CLOCK` names, which `clock --days-ago`
// writes, so a fixture can hold events from before this week. No file, no shift.
import { readFileSync } from 'node:fs'

const file = process.env.MANOR_VERIFY_CLOCK
if (file) {
  const real = Date.now.bind(Date)
  const DAY_MS = 86_400_000
  let readAt = 0
  let behind = 0
  Date.now = () => {
    const now = real()
    // Read at most four times a second: the store asks for the time on every event.
    if (now - readAt > 250) {
      readAt = now
      try {
        behind = (Number(readFileSync(file, 'utf8')) || 0) * DAY_MS
      } catch {
        behind = 0
      }
    }
    return now - behind
  }
}
