import type { ThreadEvent } from '@manor/contracts'
import { typedByUser } from './composer.js'

// Function words only Dutch uses. Words English shares or reads otherwise ("of",
// "want", "die", "door", "was", "even"), and words French, Spanish, Italian, German
// or the Scandinavian languages also use ("de", "en", "je", "kan", "om", "op", "ja",
// "van", "dan", "met", "nu", "nog", "hem") are left out.
const DUTCH = new Set(('het een ik jij jou jouw niet wat dat voor maar ook wel wil zijn naar deze hoe waarom ' +
  'kunnen moet geen aan bij uit heb hebt heeft mijn graag dus omdat waar wordt worden zou zie ga gaat komt klopt ' +
  'welke weet iets mee alleen nee denk doe toch goed oke zeker leuk kun wanneer elke moeten hoelaat precies').split(' '))
const ENGLISH = new Set(('the a and i you not what that for with on to but also still if can are then this how why ' +
  'should no it have has my your will would there which just only now because where does do don\'t it\'s i\'m ' +
  'i\'ve i\'ll yes think done who please').split(' '))

/**
 * Dutch or English when the words say so clearly, otherwise undefined: a short or
 * mixed message, or another language. Code, links and inline code are not counted.
 */
export function writtenLanguage(text: string): 'Dutch' | 'English' | undefined {
  const prose = text.replace(/```[\s\S]*?```|`[^`]*`|https?:\/\/\S+/g, ' ').toLowerCase()
  const words = prose.match(/[\p{L}']+/gu) ?? []
  const dutch = words.filter((word) => DUTCH.has(word)).length
  const english = words.filter((word) => ENGLISH.has(word)).length
  if (dutch >= 2 && dutch >= 2 * english) return 'Dutch'
  if (english >= 2 && english >= 2 * dutch) return 'English'
  return undefined
}

const OPENING_MAX = 80

function opening(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= OPENING_MAX) return flat
  const cut = flat.slice(0, OPENING_MAX)
  return `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : OPENING_MAX)}…`
}

/**
 * The message that started turn `turnId`, or one the user added to it: the newest
 * user message after the last reply of an earlier turn. Queued messages wait for a
 * later turn, and a project thread's sent-on messages trail the user's own, as in
 * the turn message.
 */
function turnTrigger(events: readonly ThreadEvent[], turnId: string): ThreadEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'agent_message' && event.turnId !== turnId) return undefined
    if (event?.type === 'user_message' && event.dispatchState !== 'pending' && event.source !== 'project_thread') return event
  }
  return undefined
}

/**
 * The reminder a Manor tool result carries so the reply after it keeps the user's
 * language. The instruction in the turn message sits before the tool round; after a
 * long English brief and an English result the reply drifted to English, so this
 * one lands where the reply is written. Undefined when the user's typed message did
 * not start the turn (a routine, kickoff, wake or relay return) or when they wrote
 * English, which the result cannot pull away from.
 */
export function replyLanguageNote(events: readonly ThreadEvent[], turnId: string): string | undefined {
  const trigger = turnTrigger(events, turnId)
  if (trigger?.type !== 'user_message' || !typedByUser(trigger)) return undefined
  const language = writtenLanguage(trigger.text)
  if (language === 'English') return undefined
  return language === undefined
    ? `[Manor] Reply to the user in the language of their message ("${opening(trigger.text)}"), whatever language this result is in.`
    : `[Manor] The user wrote ${language}. Reply to them in ${language}, whatever language this result is in.`
}
