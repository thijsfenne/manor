import ArrowUp02Icon from '@hugeicons/core-free-icons/ArrowUp02Icon'
import Attachment01Icon from '@hugeicons/core-free-icons/Attachment01Icon'
import BotIcon from '@hugeicons/core-free-icons/BotIcon'
import BoxIcon from '@hugeicons/core-free-icons/BoxIcon'
import Camera01Icon from '@hugeicons/core-free-icons/Camera01Icon'
import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon'
import File01Icon from '@hugeicons/core-free-icons/File01Icon'
import Globe02Icon from '@hugeicons/core-free-icons/Globe02Icon'
import Image01Icon from '@hugeicons/core-free-icons/Image01Icon'
import LeftToRightListBulletIcon from '@hugeicons/core-free-icons/LeftToRightListBulletIcon'
import MessageMultiple01Icon from '@hugeicons/core-free-icons/MessageMultiple01Icon'
import PlusSignIcon from '@hugeicons/core-free-icons/PlusSignIcon'
import { HugeiconsIcon } from '@hugeicons/react-native'
import { DocumentUploadSchema, ImageAttachmentSchema, FileAttachmentSchema, MAX_DOCUMENT_BYTES, MAX_MESSAGE_ATTACHMENTS, MAX_TEXT_FILE_BYTES, imageRefSpans, renumberImageRefs, snapRefDeletion, type AgentConfig, type ChatCommandContext, type DriverName, type ImageAttachment, type MessageQuote, type MessageReply, type SkillConfig } from '@manor/contracts'
import { base64Bytes, describeBytes, documentMime, documentTooLarge, isDocumentUpload, textFileMime, utf8Size, type StagedFile } from '@manor/client-runtime/attachments'
import { editComposerText, normalizeComposerLists } from '@manor/client-runtime/composer-formatting'
import {
  activeImageRef,
  activeMention,
  activeSkill,
  applyImageRef,
  applyMention,
  applySkill,
  eligibleSkills,
  insertTrigger,
  matchAgents,
  matchesBrowserMention,
  matchesWorkMention,
  matchFiles,
  matchImageRefs,
  matchSkills,
} from '@manor/client-runtime/mentions'
import * as DocumentPicker from 'expo-document-picker'
import { File } from 'expo-file-system'
import { Image } from 'expo-image'
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator'
import * as ImagePicker from 'expo-image-picker'
import { useCallback, useEffect, useMemo, useRef, useState, type Ref } from 'react'
import { Pressable, ScrollView, StyleSheet, View, type LayoutChangeEvent, type TextInputSelectionChangeEventData, type NativeSyntheticEvent } from 'react-native'
import { TextInput } from '@/components/TextInput'
import Animated, { FadeIn, FadeOut, LinearTransition, ReduceMotion } from 'react-native-reanimated'

import { Blobatar } from '@/components/Blobatar'
import { ContextRingButton, ContextRingCopy } from '@/components/ContextRing'
import type { ContextMeter } from '@manor/client-runtime/context-meter'
import { chatCommandRows, commandDraft, draftCommandRefusal, type ChatCommandRow } from '@manor/client-runtime/chat-commands'
import { GlassSurface } from '@/components/GlassSurface'
import { shortModelName } from '@/components/modelPillLabel'
import { ProviderMark } from '@/components/ProviderMark'
import { ReplyContextChip } from '@/components/ReplyContextChip'
import { QuoteContextChip } from '@/components/QuoteContextChip'
import { glassRise, glassSink } from '@/lib/glassMotion'
import { Text } from '@/components/Text'
import { ImageNumberBadge } from '@/components/Attachments'
import { colors, fonts, radius, spacing, squircle, tracking } from '@/theme'
import { addImagePasteListener, setImagePasteEnabled } from '../../modules/manor-image-paste/src'

/**
 * Pictures and text files share one allowance on the wire, so the pickers count
 * what is already staged rather than each keeping its own tally.
 */
const MAX_ATTACHMENTS = MAX_MESSAGE_ATTACHMENTS

/**
 * How tall a menu may grow before it scrolls. Four two-line rows, and deliberately
 * short of the transcript's own header: the card floats over the conversation
 * rather than pushing it, so anything taller would cover the chat's title instead
 * of a few lines someone can still read through the glass.
 */
const MENU_MAX_HEIGHT = 300

/**
 * A row's corner inside the card, kept concentric with it: an inner radius is the
 * outer one minus the gap between the two curves, or the inner corner reads as a
 * differently-shaped box sitting crooked in a rounder one. Derived rather than
 * written down, so changing the card's padding cannot quietly break the pairing.
 */
const ROW_RADIUS = radius.panel - spacing.xs

/**
 * The resting pill's height, and the corner both shapes share: half of it, so the
 * pill is a true capsule and the card it opens into keeps the same curve rather than
 * snapping to a different radius mid-transition.
 */
const PILL_HEIGHT = 52
const COMPOSER_RADIUS = PILL_HEIGHT / 2

/** How the composer opens and closes, a shade quicker than the keyboard it rides on. */
const OPEN_TRANSITION = LinearTransition.duration(200).reduceMotion(ReduceMotion.System)
const BUTTON_IN = FadeIn.duration(160).reduceMotion(ReduceMotion.System)

/**
 * Longest edges tried in turn until the JPEG fits the wire's 2,000,000-character
 * data URL. A phone photo is 12 to 48 megapixels and no CLI reads more than the
 * first step of this offers; the later steps exist for a dense screenshot that
 * still will not compress.
 */
const RESIZE_STEPS = [1600, 1200, 900, 640]

/** The picked file as a JPEG the contract accepts, or nothing when even 640px will not fit. */
async function fitImage(uri: string, name: string): Promise<ImageAttachment | undefined> {
  for (const width of RESIZE_STEPS) {
    const shrunk = await manipulateAsync(uri, [{ resize: { width } }], { compress: 0.72, format: SaveFormat.JPEG, base64: true })
    if (shrunk.base64 === undefined) continue
    const parsed = ImageAttachmentSchema.safeParse({ name, dataUrl: `data:image/jpeg;base64,${shrunk.base64}` })
    if (parsed.success) return parsed.data
  }
  return undefined
}

/** One suggestion row. Every kind shares the card and the tap that picks it. */
type MentionRow =
  | { kind: 'browser' }
  | { kind: 'work' }
  | { kind: 'agent'; agent: AgentConfig }
  | { kind: 'file'; path: string }
  | { kind: 'skill'; skill: SkillConfig }
  | { kind: 'image'; number: number; image: ImageAttachment }
  | { kind: 'command'; command: ChatCommandRow }

export interface ComposerProps {
  /** The text field itself, for a screen that measures where a sent message leaves from. */
  fieldRef?: Ref<TextInput>
  /** Read only when a draft opens with `/`, because it walks the transcript. Absent while a quote or reply rides along, which makes any text a message. */
  commandContext?: (() => ChatCommandContext) | undefined
  draft: string
  onChangeDraft: (draft: string) => void
  images: ImageAttachment[]
  onChangeImages: (images: ImageAttachment[]) => void
  /**
   * Files staged on this draft: text read here, PDF and Word as originals the Mac
   * extracts. Named apart from `files`, which is this project's mentionable paths
   * and has nothing to do with what rides along.
   */
  textFiles?: StagedFile[]
  onChangeTextFiles?: (files: StagedFile[]) => void
  placeholder: string
  /** The socket is down: the draft stays, nothing leaves. */
  disabled?: boolean
  /** A turn is running: send becomes stop. */
  busy?: boolean
  /** Waiting on the server to confirm the send, on the new-chat stage. */
  submitting?: boolean
  /**
   * The draft as it should leave, with the composer's typographic bullets turned
   * back into portable Markdown. Handed over rather than read from state, because
   * the parent's copy is one render behind that normalisation.
   */
  onSend: (text: string) => void
  onStop?: () => void
  /** Who a `@` can address. Empty leaves `@` pointing at files alone. */
  mentionable?: AgentConfig[]
  /** Work is a DM-only destination. */
  allowWorkDestination?: boolean
  /**
   * The whole house, for reading who a typed draft addresses. Mentions are parsed
   * against everyone and then filtered to `mentionable` and `memberIds`, the way the
   * server drops an outsider or a persona this room cannot seat, so naming someone who
   * is not in the room reaches nobody rather than
   * quietly falling back to whoever spoke last. Defaults to the picker's list, which
   * is what a solo room wants: a DM parses no mentions at all, so its skills come
   * off `fallbackTargets` no matter whose name is typed.
   */
  roster?: AgentConfig[]
  /** Invited ids of a group. Absent in a project chat, which has no membership. */
  memberIds?: readonly string[]
  /**
   * Mentionable files in this project's linked folders, as `<folder-name>/<path>`.
   * Empty is the ordinary state for a project with no folder linked, and also what a
   * listing that has not arrived yet looks like: the menu simply offers personas.
   */
  files?: string[]
  /** The server's cap cut the file list, which the menu says out loud. */
  filesTruncated?: boolean
  /** Imported skills. Agent attachment decides which ones the `$` menu offers. */
  skills?: SkillConfig[]
  allSkillsAvailable?: boolean
  /**
   * Who an un-mentioned draft goes to, so the `$` menu offers that persona's skills.
   * Absent means the chief of staff, the server's last fallback.
   */
  fallbackTargets?: AgentConfig[]
  /**
   * Who the draft reaches if sent now, restating the server's routing the way the
   * Mac does next to its plus. `'unknown'` while a turn is still running, since an
   * unmarked follow-up cannot name its target yet; empty is a real state, a group
   * nobody in the room answers for. Absent hides the label, as on the new-chat stage.
   */
  recipients?: AgentConfig[] | 'unknown'
  /** The finished answer this draft targets, shown above the input until removed or sent. */
  replyTo?: MessageReply
  replyName?: string
  onRemoveReply?: () => void
  quote?: MessageQuote
  onRemoveQuote?: () => void
  /** An empty draft may go: opening a chat with nothing to say is a real choice. */
  allowEmpty?: boolean
  autoFocus?: boolean
  onLayout?: (event: LayoutChangeEvent) => void
  /** Single Work session fill. Absent on Multiple, DM, house and the house new-chat. */
  contextMeter?: ContextMeter
  /**
   * The model this chat runs on, as a chip beside the plus once the composer opens.
   * Present where one runtime answers (a DM, a Single Session, a project thread);
   * the press opens that chat's model sheet.
   */
  model?: { label: string; driver?: DriverName; effort?: string; onPress: () => void }
}

/**
 * The phone's composer: glass, the same actions the Mac keeps under its plus. At
 * rest it is one pill, the plus, the field and send. Focused, or holding anything to
 * send, it opens into a card: text on top, and under it the plus holding everything
 * that is not typing (`@` and `$` included), the model chip where one runtime
 * answers, and the one button that is send while nothing runs and stop while
 * something does. `@` names a persona or a file and `$` runs a
 * skill, both reading the same rules as the Mac. The parent owns the draft and what
 * sending means, so the same composer opens a chat and continues one.
 *
 * What a trigger opens is a glass card standing on the composer and lying over the
 * conversation, the way iOS puts a menu over the page it belongs to rather than
 * shoving it aside. Deliberately over and not above: the thread stays legible
 * through it, so the message being answered is still readable while a skill is
 * picked. Both cards are the same material as the composer under them.
 */
export function Composer({
  fieldRef,
  commandContext,
  draft,
  onChangeDraft,
  images,
  onChangeImages,
  textFiles = [],
  onChangeTextFiles,
  placeholder,
  disabled = false,
  busy = false,
  submitting = false,
  onSend,
  onStop,
  mentionable = [],
  allowWorkDestination = true,
  roster,
  memberIds,
  files = [],
  filesTruncated = false,
  skills = [],
  allSkillsAvailable = false,
  fallbackTargets,
  recipients,
  replyTo,
  replyName,
  onRemoveReply,
  quote,
  onRemoveQuote,
  allowEmpty = false,
  autoFocus = false,
  onLayout,
  contextMeter,
  model,
}: ComposerProps) {
  const [pickError, setPickError] = useState<string | null>(null)
  // Why a command did not run, until the draft changes.
  const [commandNote, setCommandNote] = useState<string | null>(null)
  useEffect(() => setCommandNote(null), [draft])
  const [plusOpen, setPlusOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  // Stable, so the memoized ring skips the renders streamed tokens cause around it.
  const toggleContext = useCallback(() => {
    setPlusOpen(false)
    setContextOpen((open) => !open)
  }, [setPlusOpen, setContextOpen])
  const inputFocused = useRef(false)
  /** Mirrors `inputFocused` for rendering: focus is what opens the pill into a card. */
  const [focused, setFocused] = useState(autoFocus)
  /**
   * What the input last reported, start and end. The end is not decoration: a
   * collapsed caret is the only state in which the pre-edit position can explain a
   * one-character edit, and replacing a selection has to fall back to the diff.
   */
  const [selection, setSelection] = useState({ start: draft.length, end: draft.length })
  const caret = selection.start
  /**
   * A selection the composer wrote rather than the keyboard, handed to the input for
   * exactly one render. Held permanently it would fight the native caret on every
   * tap; released on the first selection the input reports back.
   */
  const [forced, setForced] = useState<{ start: number; end: number } | null>(null)
  /** What one message may still carry, pictures and text files counted together. */
  const room = MAX_ATTACHMENTS - images.length - textFiles.length
  const canSend = !disabled && !submitting && (allowEmpty || draft.trim() !== '' || images.length > 0 || textFiles.length > 0 || quote !== undefined)
  // Stop only while there is nothing to send: a follow-up typed during a turn queues
  // behind it, and taking the send button away would make that impossible.
  const showStop = busy && onStop !== undefined && draft.trim() === '' && images.length === 0 && textFiles.length === 0 && quote === undefined
  // Anything waiting to leave keeps the card open, so a blur never hides a draft,
  // an attachment or the message being answered behind the resting pill.
  const holding = draft !== '' || images.length > 0 || textFiles.length > 0 || quote !== undefined || replyTo !== undefined
  const expanded = focused || holding

  useEffect(() => {
    const subscription = addImagePasteListener((event) => {
      if (!inputFocused.current) return
      if (event.error === 'too_large') {
        setPickError('Manor could not shrink this image enough.')
        return
      }
      if (room <= 0) {
        setPickError(`You can attach up to ${MAX_ATTACHMENTS} files.`)
        return
      }
      const parsed = ImageAttachmentSchema.safeParse(event)
      if (!parsed.success) {
        setPickError('Manor could not attach this image.')
        return
      }
      setPickError(null)
      onChangeImages([...images, parsed.data])
    })
    return () => subscription.remove()
  }, [images, onChangeImages, room])

  useEffect(() => () => {
    if (inputFocused.current) setImagePasteEnabled(false)
  }, [])

  const mention = activeMention(draft, caret)
  const visibleRoster = roster ?? mentionable
  // A `$` that opens nothing is left as the character it is, so a price typed into a
  // composer with no skills behind it stays plain text.
  const skillQuery = skills.length === 0 ? null : activeSkill(draft, caret)
  // `#` picks one of the staged pictures, as `[Image #n]`, the reference the Mac draws as a chip.
  const imageQuery = mention === null && skillQuery === null ? activeImageRef(draft, caret, images.length) : null
  const commandQuery = commandContext === undefined || images.length + textFiles.length > 0 ? null : commandDraft(draft)
  const completion = mention !== null
    ? { kind: 'mention' as const, ...mention }
    : skillQuery !== null
      ? { kind: 'skill' as const, ...skillQuery }
      : imageQuery !== null
        ? { kind: 'image' as const, ...imageQuery }
        : commandQuery === null ? null : { kind: 'command' as const, query: commandQuery, start: 0 }

  const availableSkills = useMemo(
    () => allSkillsAvailable ? skills : eligibleSkills(draft, visibleRoster, skills, fallbackTargets, memberIds, mentionable),
    [allSkillsAvailable, draft, visibleRoster, mentionable, memberIds, skills, fallbackTargets],
  )

  // Personas first and always: the roster is short, it is the reason `@` exists, and
  // a file list arriving later must never push a persona off the top of the menu.
  const fileRows = completion?.kind === 'mention' ? matchFiles(files, completion.query) : []
  const matches: MentionRow[] = completion === null
    ? []
    : completion.kind === 'command'
      ? commandContext === undefined ? [] : chatCommandRows(commandContext(), completion.query).map((command): MentionRow => ({ kind: 'command', command }))
    : completion.kind === 'skill'
      ? matchSkills(availableSkills, completion.query).map((skill): MentionRow => ({ kind: 'skill', skill }))
      : completion.kind === 'image'
      ? matchImageRefs(images.length, completion.query).flatMap((number): MentionRow[] => {
          const image = images[number - 1]
          return image === undefined ? [] : [{ kind: 'image', number, image }]
        })
      : [
          ...matchAgents(mentionable, completion.query)
            .filter((agent) => memberIds === undefined || memberIds.includes(agent.id))
            .map((agent): MentionRow => ({ kind: 'agent', agent })),
          ...(matchesBrowserMention(completion.query) ? [{ kind: 'browser' as const }] : []),
          ...(allowWorkDestination && matchesWorkMention(completion.query) ? [{ kind: 'work' } as const] : []),
          ...fileRows.map((path): MentionRow => ({ kind: 'file', path })),
        ]
  // A `$` menu with no eligible rows still opens. Silence reads as a broken trigger;
  // the empty state can instead point to the missing import or agent attachment. It
  // closes the way it opened, on the token: a space ends the trigger and the list.
  const menuOpen = completion !== null && (matches.length > 0 || completion.kind === 'skill')

  /** Writes a draft the composer produced itself, and puts the caret where it belongs. */
  const write = (text: string, at: number) => {
    onChangeDraft(text)
    setSelection({ start: at, end: at })
    setForced({ start: at, end: at })
  }

  /**
   * Every keystroke passes here so a list keeps itself. Typing `- ` opens a bullet,
   * and a newline inside a list item continues it or, on an empty item, ends it —
   * the phone's Enter is the Mac's Shift+Enter, since neither sends. The caret is
   * only taken back from the input where the rules actually rewrote the line.
   *
   * `caret` is still the pre-edit selection here. UIKit reports the selection
   * first, and `RCTBackedTextInputDelegateAdapter` deliberately re-emits the change
   * ahead of it, so JS always sees `onChangeText` before `onSelectionChange`. That
   * is exactly the fact the list rules need: the two strings alone cannot tell a
   * newline typed at the end of `\u2022 item` from one typed after the newline that
   * already follows it. Should that order ever flip, `composerCaret` refuses the
   * value it cannot verify and falls back to the diff.
   */
  const type = (next: string) => {
    // Only a collapsed caret is handed over. With a range selected, `start` is where
    // the replacement began and says nothing about how much of it survived.
    // A backspace into `[Image #n]` takes the whole reference, as the Mac's chip goes.
    const snapped = snapRefDeletion(draft, next, imageRefSpans(draft, images.length), selection)
    if (snapped !== null) {
      write(snapped.text, snapped.caret)
      return
    }
    const before = selection.start === selection.end ? selection.start : undefined
    const edited = editComposerText(draft, next, before)
    onChangeDraft(edited.text)
    setSelection({ start: edited.selectionStart, end: edited.selectionEnd })
    if (edited.text !== next) setForced({ start: edited.selectionStart, end: edited.selectionEnd })
  }

  const track = (event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
    setSelection(event.nativeEvent.selection)
    if (forced !== null) setForced(null)
  }

  const pick = (row: MentionRow) => {
    if (completion === null) return
    if (row.kind === 'command') {
      // A refused row already says why.
      if (row.command.refusal !== undefined) return
      if (row.command.runs) submit(row.command.command)
      else write(`${row.command.command} `, row.command.command.length + 1)
      return
    }
    const next = row.kind === 'skill'
      ? applySkill(draft, caret, completion.start, row.skill.id)
      : row.kind === 'image'
      ? applyImageRef(draft, caret, completion.start, row.number)
      : applyMention(draft, caret, completion.start, row.kind === 'agent' ? row.agent.name : row.kind === 'browser' ? 'browser' : row.kind === 'work' ? 'work' : row.path)
    write(next.text, next.caret)
  }

  /**
   * Types a trigger for someone who does not know it exists, at the caret they left
   * behind. The menu that follows is the same one typing `@` opens: the plus is a
   * way in, not a second mechanism.
   */
  const typeTrigger = (trigger: '@' | '$' | '#') => {
    const next = insertTrigger(draft, caret, trigger)
    write(next.text, next.caret)
    setPlusOpen(false)
  }

  /** Opens a list on the current line, for a thumb that will not type `- ` by hand. */
  const startList = () => {
    const lineStart = draft.lastIndexOf('\n', caret - 1) + 1
    const onBlankLine = draft.slice(lineStart, caret).trim() === ''
    const lead = caret === 0 || onBlankLine ? '' : '\n'
    const inserted = `${lead}• `
    write(`${draft.slice(0, caret)}${inserted}${draft.slice(caret)}`, caret + inserted.length)
    setPlusOpen(false)
  }

  /** A picture leaves and later numbers move up one; the draft's references follow them. */
  const removeImage = (index: number) => {
    const next = renumberImageRefs(draft, index + 1, images.length)
    if (next !== draft) write(next, Math.min(caret, next.length))
    onChangeImages(images.filter((_, at) => at !== index))
  }

  const submit = (picked?: string) => {
    setPlusOpen(false)
    const text = picked ?? normalizeComposerLists(draft)
    // Refused here, so the draft stays and the reason stands right under it.
    const refusal = commandContext === undefined || !text.trim().startsWith('/') ? undefined
      : draftCommandRefusal({ text, images, files: textFiles }, commandContext())
    if (refusal !== undefined) {
      setCommandNote(refusal)
      return
    }
    setForced(null)
    onSend(text)
  }

  const pickImages = async () => {
    setPickError(null)
    setPlusOpen(false)
    // PHPicker grants only the photos the user selects, so asking for full-library
    // permission first adds no capability and terminates an older dev build whose
    // Info.plist predates that permission string.
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: room,
    }).catch(() => null)
    if (result === null) {
      setPickError('The photo picker could not open. Update the Manor app and try again.')
      return
    }
    if (result.canceled) return
    let dropped = 0
    const picked: ImageAttachment[] = []
    for (const [index, asset] of result.assets.entries()) {
      // Whatever the library held (HEIC included) leaves here as a resized JPEG, so
      // that is the only honest label and the original extension goes.
      const name = `${(asset.fileName ?? `photo-${index + 1}`).replace(/\.[^.]+$/, '')}.jpg`
      const fitted = await fitImage(asset.uri, name).catch(() => undefined)
      if (fitted === undefined) dropped += 1
      else picked.push(fitted)
    }
    if (dropped > 0) setPickError(dropped === 1 ? 'Manor could not shrink one photo enough, so it was not added.' : `Manor could not shrink ${dropped} photos enough, so they were not added.`)
    onChangeImages([...images, ...picked].slice(0, images.length + room))
  }

  /**
   * One photo, taken now. Its own row rather than a mode of the library picker,
   * because the two answer different intents: "the thing in front of me" and "the
   * thing I already have". Permission is asked here and nowhere else, so a refusal
   * says so instead of opening a black screen.
   */
  const takePhoto = async () => {
    setPickError(null)
    setPlusOpen(false)
    const permission = await ImagePicker.requestCameraPermissionsAsync().catch(() => null)
    if (permission === null || !permission.granted) {
      setPickError('Manor is not allowed to use the camera. Turn it on in Settings → Manor.')
      return
    }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'] }).catch(() => null)
    if (result === null) {
      setPickError('The camera could not open. Update the Manor app and try again.')
      return
    }
    if (result.canceled) return
    const asset = result.assets[0]
    if (asset === undefined) return
    const fitted = await fitImage(asset.uri, 'photo.jpg').catch(() => undefined)
    if (fitted === undefined) {
      setPickError('Manor could not shrink this photo enough.')
      return
    }
    onChangeImages([...images, fitted])
  }

  /**
   * A file out of Files. Everything is offered rather than filtered by type, because
   * iOS greys out a `.md` under any mime filter that would also let a `.txt` through;
   * what is not text, PDF or Word is refused here, by name, instead of being
   * unpickable there.
   */
  const pickFiles = async () => {
    setPickError(null)
    setPlusOpen(false)
    if (onChangeTextFiles === undefined) return
    const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true }).catch(() => null)
    if (result === null) {
      setPickError('The file picker could not open. Update the Manor app and try again.')
      return
    }
    if (result.canceled) return
    const problems: string[] = []
    const picked: StagedFile[] = []
    for (const asset of result.assets.slice(0, room)) {
      const document = documentMime(asset.name, asset.mimeType)
      if (document !== null) {
        if ((asset.size ?? 0) > MAX_DOCUMENT_BYTES) {
          problems.push(documentTooLarge(asset.name))
          continue
        }
        const data = await new File(asset.uri).base64().catch(() => null)
        const parsed = data === null ? null : DocumentUploadSchema.safeParse({ name: asset.name, mime: document, data })
        if (parsed?.success === true) picked.push(parsed.data)
        else problems.push(data === null ? `Manor could not read ${asset.name}.` : `${asset.name} cannot be attached.`)
        continue
      }
      const mime = textFileMime(asset.name, asset.mimeType)
      if (mime === null) {
        problems.push(`${asset.name} is not a text, PDF or Word file.`)
        continue
      }
      if ((asset.size ?? 0) > MAX_TEXT_FILE_BYTES) {
        problems.push(`${asset.name} is larger than ${Math.round(MAX_TEXT_FILE_BYTES / 1024)} KB.`)
        continue
      }
      const content = await new File(asset.uri).text().catch(() => null)
      if (content === null) {
        problems.push(`Manor could not read ${asset.name}.`)
        continue
      }
      const parsed = FileAttachmentSchema.safeParse({ name: asset.name, mime, content })
      if (parsed.success) picked.push(parsed.data)
      else problems.push(`${asset.name} cannot be attached.`)
    }
    if (result.assets.length > room) problems.push(`You can attach up to ${MAX_ATTACHMENTS} files.`)
    if (picked.length > 0) onChangeTextFiles([...textFiles, ...picked])
    setPickError(problems[0] ?? null)
  }

  const canMentionAgents = mentionable.length > 0
  const mentionLabel = canMentionAgents
    ? (files.length > 0
      ? (allowWorkDestination ? 'Mention an agent, file, browser or Sessions' : 'Mention an agent, file or browser')
      : (allowWorkDestination ? 'Mention an agent, browser or Sessions' : 'Mention an agent or browser'))
    : (files.length > 0
      ? (allowWorkDestination ? 'Reference a file, browser or Sessions' : 'Reference a file or browser')
      : (allowWorkDestination ? 'Use the Manor browser or send to Sessions' : 'Use the Manor browser'))

  const plusButton = (
    <Pressable
      accessibilityLabel="Attach and insert"
      accessibilityRole="button"
      accessibilityState={{ expanded: plusOpen }}
      disabled={disabled}
      hitSlop={4}
      onPress={() => {
        setContextOpen(false)
        setPlusOpen((open) => !open)
      }}
      style={({ pressed }) => [styles.plus, plusOpen && styles.plusOn, disabled && styles.dimmed, pressed && styles.pressed]}
    >
      <HugeiconsIcon color={colors.text} icon={PlusSignIcon} size={20} strokeWidth={1.8} />
    </Pressable>
  )

  const sendButton = showStop ? (
    <Animated.View entering={FadeIn.duration(120).reduceMotion(ReduceMotion.System)} exiting={FadeOut.duration(80).reduceMotion(ReduceMotion.System)} key="stop">
      <Pressable accessibilityLabel="Stop" accessibilityRole="button" onPress={onStop} style={({ pressed }) => [styles.send, pressed && styles.pressed]}>
        {/* A filled square rather than an outlined glyph: at eleven points a
            stroke reads as a box, and stop is the one press that must not
            look like a frame around something else. */}
        <View style={styles.stopMark} />
      </Pressable>
    </Animated.View>
  ) : (
    <Animated.View entering={FadeIn.duration(120).reduceMotion(ReduceMotion.System)} exiting={FadeOut.duration(80).reduceMotion(ReduceMotion.System)} key="send">
      <Pressable
        accessibilityLabel={submitting ? 'Sending…' : 'Send'}
        accessibilityRole="button"
        disabled={!canSend}
        onPress={() => submit()}
        style={({ pressed }) => [styles.send, !canSend && styles.sendIdle, pressed && styles.pressed]}
      >
        <HugeiconsIcon color={canSend ? colors.onPrimary : colors.muted} icon={ArrowUp02Icon} size={18} strokeWidth={2.2} />
      </Pressable>
    </Animated.View>
  )

  return (
    <View onLayout={onLayout} style={styles.host}>
      {menuOpen ? (
        <Animated.View entering={glassRise} exiting={glassSink} style={[styles.overlay, styles.menuOverlay]}>
          <GlassSurface fallbackStyle={styles.floatingFallback} radius={radius.panel}>
            <ScrollView
              contentContainerStyle={styles.menuRows}
              keyboardShouldPersistTaps="always"
              showsVerticalScrollIndicator={false}
              style={styles.menuScroll}
            >
              {completion?.kind === 'skill' && matches.length === 0 ? (
                <Text style={styles.menuEmpty}>
                  {skills.length === 0
                    ? 'No skills imported. Import one under Plugins → Skills.'
                    : availableSkills.length === 0
                      ? 'No shared skills for the addressed agent. Attach them under Agents.'
                      : 'No skill matches this search.'}
                </Text>
              ) : null}
              {matches.map((row) => (
                <SuggestionRow key={rowKey(row)} onPick={() => pick(row)} row={row} />
              ))}
              {/* Said only where it could mislead: the list looks complete either way. */}
              {completion?.kind === 'mention' && filesTruncated && fileRows.length > 0 ? (
                <Text style={styles.menuNote}>Showing part of this project’s files; keep typing to narrow it down.</Text>
              ) : null}
            </ScrollView>
          </GlassSurface>
        </Animated.View>
      ) : null}

      {plusOpen ? (
        <Animated.View entering={glassRise} exiting={glassSink} style={[styles.overlay, styles.plusOverlay]}>
          <GlassSurface fallbackStyle={styles.floatingFallback} radius={radius.panel}>
            <ScrollView
              contentContainerStyle={styles.menuRows}
              keyboardShouldPersistTaps="always"
              showsVerticalScrollIndicator={false}
              style={styles.menuScroll}
            >
              <PlusRow
                disabled={room <= 0}
                hint={`max ${MAX_ATTACHMENTS}`}
                icon={Image01Icon}
                label="Add photos"
                onPick={() => void pickImages()}
              />
              <PlusRow
                disabled={room <= 0}
                icon={Camera01Icon}
                label="Take photo"
                onPick={() => void takePhoto()}
              />
              {onChangeTextFiles === undefined ? null : (
                <PlusRow
                  disabled={room <= 0}
                  icon={Attachment01Icon}
                  label="Add file"
                  onPick={() => void pickFiles()}
                />
              )}
              {mentionLabel === null ? null : (
                <PlusRow hint="@" icon={canMentionAgents ? BotIcon : files.length > 0 ? File01Icon : Globe02Icon} label={mentionLabel} onPick={() => typeTrigger('@')} />
              )}
              {skills.length === 0 ? null : (
                <PlusRow hint="$" icon={BoxIcon} label="Run a skill" onPick={() => typeTrigger('$')} />
              )}
              {images.length === 0 ? null : (
                <PlusRow hint="#" icon={Image01Icon} label="Refer to an image" onPick={() => typeTrigger('#')} />
              )}
              <PlusRow hint="- " icon={LeftToRightListBulletIcon} label="Bulleted list" onPick={startList} />
            </ScrollView>
          </GlassSurface>
        </Animated.View>
      ) : null}

      {contextMeter === undefined || !contextOpen ? null : (
        <Animated.View entering={glassRise} exiting={glassSink} style={[styles.overlay, styles.contextOverlay]}>
          <GlassSurface fallbackStyle={styles.floatingFallback} radius={radius.panel}>
            <ScrollView style={styles.ringScroll}>
              <ContextRingCopy {...contextMeter} />
            </ScrollView>
          </GlassSurface>
        </Animated.View>
      )}

      <Animated.View layout={OPEN_TRANSITION}>
      <GlassSurface fallbackStyle={styles.floatingFallback} radius={COMPOSER_RADIUS}>
        {replyTo === undefined || replyName === undefined ? null : (
          <View style={styles.replyChip}>
            <ReplyContextChip
              name={replyName}
              reply={replyTo}
              {...(onRemoveReply === undefined ? {} : { onRemove: onRemoveReply })}
            />
          </View>
        )}
        {quote === undefined ? null : (
          <View style={styles.replyChip}>
            <QuoteContextChip
              quote={quote}
              {...(onRemoveQuote === undefined ? {} : { onRemove: onRemoveQuote })}
            />
          </View>
        )}
        {images.length > 0 ? (
          <Animated.View layout={LinearTransition.duration(180).reduceMotion(ReduceMotion.System)} style={styles.thumbs}>
            {images.map((image, index) => (
              <Animated.View entering={FadeIn.duration(140).reduceMotion(ReduceMotion.System)} exiting={FadeOut.duration(100).reduceMotion(ReduceMotion.System)} key={`${image.name}:${index}`} style={styles.thumb}>
                <Image contentFit="cover" source={{ uri: image.dataUrl }} style={styles.thumbImage} />
                <ImageNumberBadge number={index + 1} />
                <Pressable
                  accessibilityLabel={`Remove ${image.name}`}
                  accessibilityRole="button"
                  hitSlop={6}
                  onPress={() => removeImage(index)}
                  style={styles.thumbRemove}
                >
                  <HugeiconsIcon color={colors.onPrimary} icon={Cancel01Icon} size={11} strokeWidth={2.2} />
                </Pressable>
              </Animated.View>
            ))}
          </Animated.View>
        ) : null}

        {textFiles.length > 0 ? (
          <Animated.View layout={LinearTransition.duration(180).reduceMotion(ReduceMotion.System)} style={styles.chips}>
            {textFiles.map((file, index) => (
              <Animated.View entering={FadeIn.duration(140).reduceMotion(ReduceMotion.System)} exiting={FadeOut.duration(100).reduceMotion(ReduceMotion.System)} key={`${file.name}:${index}`} style={styles.chip}>
                <HugeiconsIcon color={colors.muted} icon={File01Icon} size={13} strokeWidth={1.7} />
                <Text ellipsizeMode="middle" numberOfLines={1} style={styles.chipName}>{file.name}</Text>
                <Text style={styles.chipSize}>{describeBytes(isDocumentUpload(file) ? base64Bytes(file.data) : utf8Size(file.content))}</Text>
                <Pressable
                  accessibilityLabel={`Remove ${file.name}`}
                  accessibilityRole="button"
                  hitSlop={6}
                  onPress={() => onChangeTextFiles?.(textFiles.filter((_, at) => at !== index))}
                  style={styles.chipRemove}
                >
                  <HugeiconsIcon color={colors.muted} icon={Cancel01Icon} size={11} strokeWidth={2.2} />
                </Pressable>
              </Animated.View>
            ))}
          </Animated.View>
        ) : null}

        {/* One row at rest, a column once open. The input keeps its slot between the
            two buttons in both shapes, so React keeps the same native field and the
            keyboard does not drop when the pill opens around it. */}
        <View style={expanded ? styles.body : styles.pill}>
          {expanded ? null : <Animated.View entering={BUTTON_IN} key="plus-resting">{plusButton}</Animated.View>}
          <TextInput
            ref={fieldRef}
            autoFocus={autoFocus}
            editable={!disabled && !submitting}
            multiline
            onChangeText={type}
            // The plus menu has no backdrop to tap through; reaching for the text is
            // the way out of it, and every row closes it on its way to what it does.
            onBlur={() => {
              inputFocused.current = false
              setFocused(false)
              setImagePasteEnabled(false)
            }}
            onFocus={() => {
              inputFocused.current = true
              setFocused(true)
              setImagePasteEnabled(true)
              setPlusOpen(false)
            }}
            onSelectionChange={track}
            placeholder={placeholder}
            placeholderTextColor={colors.dim}
            {...(forced === null ? {} : { selection: forced })}
            selectionColor={colors.text}
            style={[styles.input, expanded ? styles.inputOpen : styles.inputResting]}
            value={draft}
          />
          {expanded ? null : <Animated.View entering={BUTTON_IN} key="send-resting">{sendButton}</Animated.View>}
        </View>

        {expanded ? (
          <Animated.View entering={BUTTON_IN} style={styles.actions}>
            {plusButton}
            {model === undefined ? null : (
              <Pressable
                accessibilityHint="Choose the model for this chat"
                accessibilityLabel={`Model, ${model.label}${model.effort ? `, ${model.effort}` : ''}`}
                accessibilityRole="button"
                disabled={disabled}
                hitSlop={4}
                onPress={() => {
                  setPlusOpen(false)
                  setContextOpen(false)
                  model.onPress()
                }}
                style={({ pressed }) => [styles.modelChip, disabled && styles.dimmed, pressed && styles.pressed]}
              >
                {model.driver === undefined ? null : <ProviderMark driver={model.driver} size={14} />}
                <Text numberOfLines={1} style={styles.modelLabel}>
                  {shortModelName(model.label)}
                  {model.effort === undefined || model.effort === '' ? null : <Text style={styles.modelEffort}>{` ${model.effort}`}</Text>}
                </Text>
              </Pressable>
            )}
            {recipients === undefined ? null : <Recipients recipients={recipients} />}
            <View style={styles.spacer} />
            {contextMeter === undefined ? null : (
              <ContextRingButton open={contextOpen} onPress={toggleContext} {...contextMeter} />
            )}
            {sendButton}
          </Animated.View>
        ) : null}
      </GlassSurface>
      </Animated.View>
      {(commandNote ?? pickError) === null ? null : <Text accessibilityRole="alert" style={styles.error}>{commandNote ?? pickError}</Text>}
    </View>
  )
}

function rowKey(row: MentionRow) {
  if (row.kind === 'browser') return 'browser'
  if (row.kind === 'command') return `command:${row.command.command}`
  if (row.kind === 'image') return `image:${row.number}`
  if (row.kind === 'work') return 'destination:work'
  return row.kind === 'agent' ? `agent:${row.agent.id}` : row.kind === 'skill' ? `skill:${row.skill.id}` : `file:${row.path}`
}

/**
 * One row of the `@` and `$` menu: the face or the mark, the name, and under it the
 * sentence that tells two of them apart. The kind rides on the right rather than in
 * an icon alone, because `@` opens one list holding both personas and files and the
 * two are only a glyph apart otherwise.
 */
function SuggestionRow({ row, onPick }: { row: MentionRow; onPick: () => void }) {
  const shell = ({ pressed }: { pressed: boolean }) => [styles.row, pressed && styles.rowPressed]

  if (row.kind === 'command') {
    const { command, description, refusal } = row.command
    return (
      <Pressable accessibilityLabel={`${command}, ${refusal ?? description}`} accessibilityRole="button" accessibilityState={{ disabled: refusal !== undefined }} onPress={onPick} style={shell}>
        <RowBody description={refusal ?? description} title={command} {...(refusal === undefined ? {} : { dimmed: true })} />
      </Pressable>
    )
  }

  if (row.kind === 'agent') {
    const { agent } = row
    return (
      <Pressable accessibilityLabel={`Mention ${agent.name}`} accessibilityRole="button" onPress={onPick} style={shell}>
        <View style={styles.rowIcon}><Blobatar color={agent.color} name={agent.name} shape={agent.avatarShape} tone={agent.avatarTone} size={24} src={agent.avatar} /></View>
        <RowBody description={agent.role} title={agent.name} tint={agent.color} />
        <Text style={styles.rowKind}>Agent</Text>
      </Pressable>
    )
  }

  if (row.kind === 'browser') {
    return (
      <Pressable accessibilityLabel="Use the Manor browser" accessibilityRole="button" onPress={onPick} style={shell}>
        <View style={styles.rowIcon}><HugeiconsIcon color={colors.muted} icon={Globe02Icon} size={18} strokeWidth={1.7} /></View>
        <RowBody description="Integrated Manor browser" title="Browser" />
        <Text style={styles.rowKind}>@browser</Text>
      </Pressable>
    )
  }

  if (row.kind === 'work') {
    return (
      <Pressable accessibilityLabel="Send to Sessions" accessibilityRole="button" onPress={onPick} style={shell}>
        <View style={styles.rowIcon}><HugeiconsIcon color={colors.muted} icon={MessageMultiple01Icon} size={18} strokeWidth={1.7} /></View>
        <RowBody description="Send a task or this discussion to Sessions" title="Sessions" />
        <Text style={styles.rowKind}>Destination</Text>
      </Pressable>
    )
  }

  if (row.kind === 'image') {
    return (
      <Pressable accessibilityLabel={`Refer to Image #${row.number}`} accessibilityRole="button" onPress={onPick} style={shell}>
        <View style={styles.rowIcon}><Image contentFit="cover" source={{ uri: row.image.dataUrl }} style={styles.rowImage} /></View>
        <RowBody description={row.image.name} title={`Image #${row.number}`} />
        <Text style={styles.rowKind}>#{row.number}</Text>
      </Pressable>
    )
  }

  if (row.kind === 'skill') {
    const { skill } = row
    return (
      <Pressable accessibilityLabel={`Run ${skill.name}`} accessibilityRole="button" onPress={onPick} style={shell}>
        <View style={styles.rowIcon}><HugeiconsIcon color={colors.muted} icon={BoxIcon} size={18} strokeWidth={1.7} /></View>
        <RowBody description={skill.description} title={skill.name} />
        <Text style={styles.rowKind}>Skill</Text>
      </Pressable>
    )
  }

  // The file name leads and its folder trails underneath, because the name is what
  // someone typed and the folder is only there to tell two of them apart.
  const cut = row.path.lastIndexOf('/')
  return (
    <Pressable accessibilityLabel={`Reference ${row.path}`} accessibilityRole="button" onPress={onPick} style={shell}>
      <View style={styles.rowIcon}><HugeiconsIcon color={colors.muted} icon={File01Icon} size={18} strokeWidth={1.7} /></View>
      <RowBody description={row.path.slice(0, Math.max(cut, 0))} title={row.path.slice(cut + 1)} />
      <Text style={styles.rowKind}>File</Text>
    </Pressable>
  )
}

/** Name over sentence. The sentence is dropped rather than left as an empty line. */
function RowBody({ title, description, tint, dimmed = false }: { title: string; description: string; tint?: string; dimmed?: boolean }) {
  return (
    <View style={[styles.rowBody, dimmed ? styles.rowDimmed : null]}>
      <Text numberOfLines={1} style={[styles.rowName, tint === undefined ? null : { color: tint }]}>{title}</Text>
      {description === '' ? null : <Text numberOfLines={2} style={styles.rowDescription}>{description}</Text>}
    </View>
  )
}

interface PlusRowProps {
  icon: Parameters<typeof HugeiconsIcon>[0]['icon']
  label: string
  /** The keystroke this row stands in for, or what the row is bounded by. Rows that
      stand for neither simply carry none. */
  hint?: string
  disabled?: boolean
  onPick: () => void
}

/** One row of the plus menu. Shaped like the suggestion rows it leads to. */
function PlusRow({ icon, label, hint, disabled = false, onPick }: PlusRowProps) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPick}
      style={({ pressed }) => [styles.plusRow, disabled && styles.dimmed, pressed && styles.rowPressed]}
    >
      <View style={styles.rowIcon}><HugeiconsIcon color={colors.muted} icon={icon} size={16} strokeWidth={1.7} /></View>
      <Text numberOfLines={1} style={styles.plusLabel}>{label}</Text>
      {hint === undefined ? null : <Text style={styles.plusHint}>{hint}</Text>}
    </Pressable>
  )
}

/** Where the draft lands, right of the `@`: "to" and the faces it reaches. */
function Recipients({ recipients }: { recipients: AgentConfig[] | 'unknown' }) {
  const label =
    recipients === 'unknown'
      ? 'Who receives this depends on the turn still in progress.'
      : recipients.length === 0
        ? 'No one receives this message. @mention an agent to summon one.'
        : `Sends to ${recipients.map((agent) => agent.name).join(', ')}`
  return (
    <View accessibilityLabel={label} style={styles.recipients}>
      <Text style={styles.recipientsTo}>to</Text>
      {recipients === 'unknown' ? (
        <Text style={styles.recipientsTo}>…</Text>
      ) : recipients.length === 0 ? (
        <Text style={styles.recipientsTo}>no one</Text>
      ) : (
        recipients.map((agent) => (
          <View key={agent.id} style={styles.recipient}>
            <Blobatar color={agent.color} name={agent.name} shape={agent.avatarShape} tone={agent.avatarTone} size={16} src={agent.avatar} />
            <Text numberOfLines={1} style={[styles.recipientName, { color: agent.color }]}>{agent.name}</Text>
          </View>
        ))
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  /* The same inset the pictures above them stand in: two strips of attachments on
     one card have to line up with each other and with the text under them. */
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  replyChip: { alignItems: 'flex-start', paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  chip: {
    alignItems: 'center',
    backgroundColor: colors.chip,
    borderRadius: ROW_RADIUS,
    ...squircle,
    flexDirection: 'row',
    gap: spacing.xs,
    maxWidth: 220,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  chipName: { color: colors.text, flexShrink: 1, fontFamily: fonts.sans, fontSize: 13 },
  chipSize: { color: colors.dim, fontFamily: fonts.sans, fontSize: 11 },
  chipRemove: { alignItems: 'center', height: 16, justifyContent: 'center', width: 16 },
  host: { gap: spacing.sm },
  recipients: { flexShrink: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: spacing.xs },
  recipientsTo: { color: colors.dim, fontFamily: fonts.sans, fontSize: 12 },
  recipient: { flexShrink: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 4 },
  recipientName: { flexShrink: 1, maxWidth: 120, fontFamily: fonts.sans, fontSize: 12, fontWeight: '500' },
  /* Out of flow on purpose. The footer measures itself to set the transcript's
     bottom inset and the height of the scrim behind the composer, and a card in
     that flow would push the conversation up and scrim what it is meant to float
     over. Anchored to the top of the composer instead, so it lands on the chat. */
  overlay: { position: 'absolute', bottom: '100%', left: 0, marginBottom: spacing.sm },
  /* The completion list is as wide as the composer it belongs to; the plus menu is
     as wide as its longest row, because it is a menu and not a list of results. */
  menuOverlay: { right: 0 },
  plusOverlay: { width: 268 },
  contextOverlay: { left: 0, right: 0 },
  floatingFallback: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.24,
    shadowRadius: 20,
    elevation: 8,
  },
  // The scroll view rounds its own corners, so rows stop at the panel's curve while the
  // glass around it keeps its rim and shadow.
  menuScroll: { maxHeight: MENU_MAX_HEIGHT, borderRadius: radius.panel, ...squircle },
  ringScroll: { maxHeight: 300, borderRadius: radius.panel, ...squircle },
  menuRows: { padding: spacing.xs },
  menuEmpty: { color: colors.dim, fontFamily: fonts.sans, fontSize: 13, lineHeight: 19, paddingHorizontal: spacing.md, paddingVertical: spacing.md },
  menuNote: { color: colors.dim, fontFamily: fonts.sans, fontSize: 11, paddingHorizontal: spacing.md, paddingVertical: 6 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, borderRadius: ROW_RADIUS, ...squircle, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  rowPressed: { backgroundColor: colors.chip },
  rowIcon: { width: 24, alignItems: 'center', paddingTop: 1 },
  rowImage: { width: 24, height: 24, borderRadius: radius.sm, ...squircle },
  rowBody: { flex: 1, minWidth: 0, gap: 1 },
  rowDimmed: { opacity: 0.5 },
  rowName: { color: colors.text, fontFamily: fonts.sans, fontSize: 16, fontWeight: '500', letterSpacing: -0.2 },
  rowDescription: { color: colors.dim, fontFamily: fonts.sans, fontSize: 13, lineHeight: 17 },
  rowKind: { paddingTop: 2, color: colors.dim, fontFamily: fonts.sans, fontSize: 12 },
  plusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderRadius: ROW_RADIUS, ...squircle, paddingHorizontal: spacing.md, paddingVertical: 11 },
  plusLabel: { flex: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 15 },
  plusHint: { color: colors.dim, fontFamily: fonts.mono, fontSize: 12 },
  thumbs: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  thumb: { width: 56, height: 56 },
  thumbImage: { width: 56, height: 56, borderRadius: radius.md, ...squircle },
  thumbRemove: { position: 'absolute', top: -5, right: -5, width: 20, height: 20, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: colors.text },
  /* At rest: plus, field and send on one line, the buttons inset so their circles sit
     concentric with the capsule's ends. */
  pill: { minHeight: PILL_HEIGHT, flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingHorizontal: (PILL_HEIGHT - 36) / 2 },
  body: { flexDirection: 'column' },
  input: { maxHeight: 140, color: colors.text, fontFamily: fonts.sans, fontSize: 17, letterSpacing: tracking.body, lineHeight: 23 },
  inputResting: { flex: 1, minHeight: 36, paddingHorizontal: spacing.xs, paddingTop: 7, paddingBottom: 6 },
  inputOpen: { minHeight: 44, paddingHorizontal: spacing.lg + 2, paddingTop: 13, paddingBottom: 3 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: (PILL_HEIGHT - 36) / 2, paddingTop: spacing.xs, paddingBottom: (PILL_HEIGHT - 36) / 2 },
  plus: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 18, backgroundColor: colors.fill },
  plusOn: { backgroundColor: colors.chip },
  modelChip: { minWidth: 0, flexShrink: 1, height: 36, flexDirection: 'row', alignItems: 'center', gap: spacing.xs, borderRadius: 18, backgroundColor: colors.fill, paddingHorizontal: spacing.md },
  modelLabel: { flexShrink: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 14, fontWeight: '500' },
  modelEffort: { color: colors.muted, fontWeight: '400' },
  spacer: { flex: 1 },
  send: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 18, backgroundColor: colors.text },
  sendIdle: { backgroundColor: colors.fill },
  stopMark: { width: 11, height: 11, borderRadius: radius.xs, ...squircle, backgroundColor: colors.onPrimary },
  dimmed: { opacity: 0.4 },
  pressed: { opacity: 0.64 },
  error: { color: colors.danger, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18, paddingHorizontal: spacing.sm },
})
