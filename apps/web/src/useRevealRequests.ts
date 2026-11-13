import { useRef, useState } from 'react'
import type { TranscriptReveal } from './components/Transcript'

type RevealTarget = { eventId: string } | { rowKey: string } | { report: true }
export type RevealRequest = TranscriptReveal & { chatId: string }
/** `beside` names the chat whose docked Knowledge panel opens the note, null for the full Knowledge view. */
export type NoteRequest = { path: string; beside: string | null; id: number }
export type ReminderRequest = { reminderId: string; id: number }

/**
 * Requests to show one thing on a surface that may not be mounted yet: a message or
 * proposal in a transcript, a note, a reminder. Mostly the ⌘K palette's picks. Each is
 * held until the surface it targets has applied it and hands its `id` back to clear it;
 * a fresh `id` makes a second pick of the same thing a new request.
 */
export function useRevealRequests() {
  const nextId = useRef(0)
  const [revealEvent, setRevealEvent] = useState<RevealRequest | null>(null)
  const [noteRequest, setNoteRequest] = useState<NoteRequest | null>(null)
  const [reminderRequest, setReminderRequest] = useState<ReminderRequest | null>(null)
  const reveal = (chatId: string, target: RevealTarget) => setRevealEvent({ chatId, ...target, id: ++nextId.current })
  const requestNote = (path: string, beside: string | null) => setNoteRequest({ path, beside, id: ++nextId.current })
  const requestReminder = (reminderId: string) => setReminderRequest({ reminderId, id: ++nextId.current })
  const clearRevealEvent = (id: number) => setRevealEvent((current) => (current?.id === id ? null : current))
  const clearNoteRequest = (id: number) => setNoteRequest((current) => (current?.id === id ? null : current))
  const clearReminderRequest = (id: number) => setReminderRequest((current) => (current?.id === id ? null : current))
  return {
    revealEvent, reveal, clearRevealEvent,
    noteRequest, requestNote, clearNoteRequest,
    reminderRequest, requestReminder, clearReminderRequest,
  }
}
