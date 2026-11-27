/**
 * Recognises a turn that ended on a promise to act now ("Now I'll run the tests.",
 * "Ik ga nu de logs bekijken.") instead of the action itself. The orchestrator gives
 * such a turn one continuation per user message.
 *
 * A text check on purpose. A stall is the model believing it handed control back, so
 * asking that same model to flag its own unfinished turn is least reliable exactly
 * when it matters, and the flag would cost every turn on every driver a standing
 * instruction. A side call to classify would spend subscription quota on every turn.
 * The check is conservative: it reads only the last sentence for an announcement, and
 * anything in the reply that hands the turn to the user (a question, a choice, an
 * approval, a later moment) makes it stand as a real ending. A miss costs the user
 * one "continue"; a false hit makes an agent act unasked.
 */

/** What the continuation is told. Never stored; the visible line is `stallNudgeLine`. */
export const STALL_CONTINUE_NUDGE =
  'Your last message said what you would do next, but the turn ended before you did it. Do that step now, unless the user has said otherwise since or it needs their approval first; then, or if you cannot do it, say why in one or two sentences. Do not repeat work you already finished.'

/** The quiet line the transcript keeps where Manor continued the turn. */
export const stallNudgeLine = (name: string): string => `${name} stopped after announcing a next step, so Manor continued.`

/** Anything here in the reply hands the next move to the user, or to later. */
const HANDS_OVER = new RegExp([
  // A choice, an approval or the user's answer.
  String.raw`let me know`, String.raw`shall i\b`, String.raw`should i\b`, String.raw`do you want`, String.raw`would you like`,
  String.raw`if you(?:'d)? (?:like|want|prefer|agree)`, String.raw`your (?:call|choice|answer|reply|input|go|ok|okay|approval|confirmation)`,
  String.raw`up to you`, String.raw`approv`, String.raw`permission`, String.raw`\b(?:reply|answer|say)\b.{0,20}\b(?:yes|no|go|ok)\b`, String.raw`go[- ]ahead`, String.raw`green light`, String.raw`(?<!\bto )\bconfirm\b`, String.raw`tell me`, String.raw`\bchoose\b`,
  String.raw`(?:once|when|after|until|unless|before) you\b`, String.raw`wait(?:ing)? (?:for|on)\b`, String.raw`which (?:option|one)`,
  String.raw`laat (?:me |het )?(?:even )?weten`, String.raw`zal ik\b`, String.raw`wil je\b`, String.raw`wilt u\b`, String.raw`\bzeg\b`, String.raw`\bkies\b`,
  String.raw`(?:jouw|je|uw) (?:keuze|antwoord|reactie|akkoord|ok[eé]?|go)\b`, String.raw`akkoord`, String.raw`goedkeur`, String.raw`(?<!\bte )\bbevestig`,
  String.raw`(?:zodra|als|wanneer|nadat|tot|voordat) (?:je|jij|u)\b`, String.raw`\bna (?:je|jouw|uw)\b`, String.raw`wacht(?:en)? op\b`, String.raw`welke optie`, String.raw`toestemming`, String.raw`\b(?:antwoord|zeg)\b.{0,20}\b(?:ja|nee)\b`,
  // A later moment, or work that runs on without this turn.
  String.raw`\blater\b`, String.raw`\bin (?:an?|\d+|a few) (?:minutes?|hours?|days?)\b`, String.raw`\bover (?:een|\d+|een paar) (?:minuut|minuten|uur|uren|dag|dagen)\b`, String.raw`tomorrow`, String.raw`tonight`, String.raw`next (?:week|time|session|turn)`, String.raw`\bsoon\b`, String.raw`for now`,
  String.raw`morgen`, String.raw`vanavond`, String.raw`volgende (?:week|keer|sessie)`, String.raw`\bstraks\b`, String.raw`binnenkort`, String.raw`voor nu\b`, String.raw`voorlopig`,
  String.raw`(?:a|een) (?:quiet|rustig|later|good|goed|ander) (?:moment|time)`, String.raw`another time`, String.raw`een andere keer`,
  String.raw`in the background`, String.raw`op de achtergrond`,
].join('|'), 'i')

/** Verbs after the promise that say the agent stops rather than acts. */
const STANDS_STILL = String.raw`(?:stop|leave|wait|pause|hold|keep|stay|park|stoppen|laten|wachten|pauzeren)`

const IMMEDIATE = /\b(?:now|next|first|right away|immediately|straight away|nu|meteen|direct|eerst|even|gelijk|dan)\b/

/** Ends on a colon or an ellipsis: the sentence opens onto an action that never came. */
const OPENS_ONTO = /(?::|\.\.\.|…)$/

const PROMISE = /\b(?:i'll|i will|i'm going to|i am going to|i'm gonna|ik ga|ga ik|ik zal)\b/
const PROMISE_STANDS_STILL = new RegExp(String.raw`${PROMISE.source} (?:\w+ )?${STANDS_STILL}\b|\bga (?:ik )?(?:ervan uit|er van uit|akkoord)\b`)

/**
 * "Now I'll run the tests." / "Ik ga nu de logs bekijken." / "I'll check one thing:"
 * The immediacy has to sit in the promise itself, from the word before it on, so a
 * "now" earlier in the sentence ("it is now over budget, so I'll trim it") does not count.
 */
function promisesNow(sentence: string): boolean {
  const at = sentence.search(PROMISE)
  if (at === -1 || PROMISE_STANDS_STILL.test(sentence)) return false
  const before = /(\S+)\s*$/.exec(sentence.slice(0, at))?.[1] ?? ''
  return IMMEDIATE.test(`${before} ${sentence.slice(at)}`) || OPENS_ONTO.test(sentence)
}

const ANNOUNCES: readonly ((sentence: string) => boolean)[] = [
  promisesNow,
  // "Let me check the logs." / "Laat me even kijken."
  (s) => /^(?:(?:now|next|first|then|so|ok(?:ay)?|alright|nu|eerst|dan|oké)[,:]? )?(?:let me|laat me) (?!know\b|weten\b)/.test(s),
  (s) => /\b(?:i'm|i am) (?:now )?about to\b/.test(s),
  // "I'm running a control check." A turn that ended is running nothing.
  (s) => /^(?:\w+: )?(?:now,? )?(?:i'm|i am) (?:now )?(?:running|checking|reading|looking|starting|building|testing|rebuilding|restarting|verifying|opening|installing)\b/.test(s),
  // "Reading it so I can follow its pattern." A bare gerund also opens a finding, so it needs a purpose.
  (s) => /^(?:now,? )?(?:reading|checking|running|looking|opening|building|testing|verifying|starting|fixing|writing|restarting|rebuilding|installing) /.test(s) &&
    (/\b(?:now|so i can|to (?:see|check|confirm|find|make sure))\b/.test(s) || OPENS_ONTO.test(s)),
  // "Nu draai ik de tests." Inversion, minus the verbs that report a state of mind.
  (s) => /^(?:nu|eerst|vervolgens) (?!(?:weet|snap|zie|begrijp|denk|vind|ben|heb|hoop|merk|kan|moet|wil|stop|wacht|pauzeer|laat)\b)\w+ ik\b/.test(s),
  // "Ik check nog of de badge klopt." Dutch present tense for the very next step.
  (s) => /\bik (?:check|kijk|controleer|test|draai|bekijk|zoek|lees|run|bouw|fix|herstart|verifieer|probeer|start) (?:nu|nog|eerst|even|meteen|dan)\b/.test(s),
  // "Even de logs checken."
  (s) => /^(?:nu |eerst )?even\b.*\b(?:checken|kijken|controleren|nakijken|testen|draaien|bekijken|zoeken|opzoeken|lezen|nagaan|verifi[eë]ren|proberen|uitzoeken|herstarten|bouwen|fixen|aanpassen|runnen)\b/.test(s),
]

/** The last paragraph of a reply, list markers and emphasis stripped. */
function lastParagraph(text: string): string {
  const paragraphs = text.trim().split(/\n\s*\n/).map((part) => part.trim()).filter((part) => part.length > 0)
  return paragraphs.at(-1) ?? ''
}

function lastSentence(paragraph: string): string {
  const lines = paragraph.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  const line = (lines.at(-1) ?? '').replace(/^(?:[-*+]|\d+[.)])\s+/, '').replace(/[*_`]+/g, '').trim()
  return line.split(/(?<=[.!])\s+/).map((part) => part.trim()).filter((part) => part.length > 0).at(-1) ?? ''
}

/** True when the reply's last sentence promises an action now and nothing hands the turn to the user. */
export function announcesNextStep(text: string): boolean {
  const trimmed = text.trim()
  // A reply ending in a code block or a table ends on content, not on a promise.
  if (trimmed.length === 0 || trimmed.endsWith('```') || trimmed.endsWith('|')) return false
  // A question anywhere in the prose waits on the user; code and links may carry a "?" of their own.
  const prose = trimmed.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '').replace(/https?:\/\/[^\s)>]+/g, '')
  if (prose.includes('?') || HANDS_OVER.test(trimmed)) return false
  const paragraph = lastParagraph(trimmed)
  const sentence = lastSentence(paragraph).toLowerCase().replace(/[’‘]/g, "'")
  if (sentence.length === 0 || sentence.length > 300) return false
  return ANNOUNCES.some((matches) => matches(sentence))
}
