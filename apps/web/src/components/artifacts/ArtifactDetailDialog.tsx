import { useId } from 'react'
import { Cancel01Icon, Folder01Icon, LinkSquare01Icon, NewTwitterIcon } from '@hugeicons/core-free-icons'
import type { MyMindArtifact, MyMindSpace } from '@manor/contracts'
import { Icon } from '../Icon'
import { Badge } from '../ui/Badge'
import { Dialog } from '../ui/Dialog'
import { AddToChatButton, type ChatDestination } from './AddToChatButton'
import {
  artifactBody,
  artifactContextId,
  formatDate,
  isXPost,
  kindLabel,
  plainText,
  xPostHandle,
} from './artifact'

interface ArtifactDetailDialogProps {
  artifact: MyMindArtifact
  spaces: MyMindSpace[]
  destinations: readonly ChatDestination[]
  /** True when this one is already staged in the chat on screen. */
  attached: boolean
  /** Whether the grid holds a selection this panel is deliberately not sending. */
  otherSelection: boolean
  onClose: () => void
  onOpenSource: (url: string) => void
  onAdd: (destination: ChatDestination) => void
}

/**
 * One artifact, the size it deserves. mymind's whole value is that a thing is
 * recognised before it is read, so the picture gets the room and the words sit beside
 * it rather than under it.
 *
 * No selection control in here. The grid owns the tray of up to three; this panel is
 * one object and has exactly one act, which is why its button says whether it is
 * sending this one alone.
 */
export function ArtifactDetailDialog({
  artifact,
  spaces,
  destinations,
  attached,
  otherSelection,
  onClose,
  onOpenSource,
  onAdd,
}: ArtifactDetailDialogProps) {
  const titleId = useId()
  const body = artifactBody(artifact)
  // A post is shown as a post even when a page screenshot came with it: the words are
  // what was saved, and the screenshot is only the page they happened to sit on.
  const post = isXPost(artifact.url) && body !== undefined
  const hasImage = !post && artifact.imageUrl !== undefined
  /** Only a wall of words scrolls; a picture, a post card and a bare title are fitted. */
  const scrolls = !hasImage && !post && body !== undefined
  const host = artifact.url === undefined ? undefined : hostOf(artifact.url)

  return (
    <Dialog
      labelledBy={titleId}
      onClose={onClose}
      trapFocus
      scrimClassName="grid place-items-center"
      inset="wide"
      className="grid h-full max-w-none grid-rows-[minmax(0,1fr)_auto] overflow-hidden lg:grid-cols-[minmax(0,1fr)_380px] lg:grid-rows-1"
    >
      {/* The visual half. Dark rather than surface-coloured, so a picture with a white
          edge is framed instead of bleeding into the panel next to it. The picture is
          fitted rather than scrolled: a page-tall screenshot half in frame is worse at
          recognising a thing than the whole of it, small, with the original one press
          away. */}
      <div
        className={`min-h-0 min-w-0 bg-bg ${
          scrolls ? 'overflow-y-auto px-8' : 'grid grid-cols-1 grid-rows-1 place-items-center overflow-hidden p-6'
        }`}
      >
        {hasImage ? (
          <img src={artifact.imageUrl} alt="" className="h-full w-full rounded-lg object-contain" />
        ) : post && body !== undefined ? (
          <XPostCard artifact={artifact} body={body} />
        ) : body === undefined ? (
          <p className="m-0 max-w-[46ch] text-center text-[22px] leading-[1.35] font-medium text-muted">
            {artifact.title}
          </p>
        ) : (
          // A note has no picture, so its words are the thing being looked at.
          //
          // The room above and below sits on this box rather than on the scroller.
          // Padding on a scroll container is dropped at the far end once the content
          // runs past it, which is exactly the case a wall of text is; an inner box
          // carries its own spacing in normal flow, so both ends survive.
          <div className="mx-auto max-w-[62ch] py-14">
            <p className="m-0 text-[15px] leading-[1.7] whitespace-pre-wrap text-text">{plainText(body)}</p>
          </div>
        )}
      </div>

      <div className="flex min-h-0 min-w-0 flex-col border-line lg:border-l">
        <div className="flex flex-none items-start gap-2 px-5 pt-4 pb-3">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="m-0 text-[19px] leading-[1.3] font-semibold tracking-[-0.01em] text-text">
              {artifact.title}
            </h2>
            <p className="mt-1.5 mb-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-dim">
              {/* "Artifact" is what mymind calls anything it could not type, which on a
                  post tells you nothing the address already said better. */}
              <span>{post ? 'X post' : kindLabel(artifact.kind)}</span>
                            <span>Saved {formatDate(artifact.created)}</span>
              {host === undefined ? null : (
                <>
                                    <span className="max-w-[180px] truncate">{host}</span>
                </>
              )}
              {!attached ? null : (
                <>
                                    <span className="text-muted">In this chat</span>
                </>
              )}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close artifact"
            title="Close (Esc)"
            onClick={onClose}
            className="-mt-1 -mr-1.5 grid h-8 w-8 flex-none cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-muted hover:bg-surface-2 hover:text-text"
          >
            <Icon icon={Cancel01Icon} size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
          {artifact.tags.length === 0 ? null : (
            <div className="flex flex-wrap gap-1.5">
              {artifact.tags.map((tag) => (
                <Badge key={tag}>{tag}</Badge>
              ))}
            </div>
          )}
          {/* Only when the visual half is a picture: a note and a post already read
              their words there. */}
          {!hasImage || body === undefined ? null : (
            <p className="mt-4 mb-0 text-label leading-6 whitespace-pre-wrap text-muted">{plainText(body)}</p>
          )}
          {spaces.length === 0 ? null : (
            <div className="mt-6 border-t border-line pt-4">
              <div className="flex flex-wrap gap-1.5">
                {spaces.map((space) => (
                  <Badge key={space.id} icon={Folder01Icon}>
                    {space.name}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-none items-center justify-between gap-2 border-t border-line bg-raised p-4">
          <button
            type="button"
            disabled={artifact.url === undefined}
            title={artifact.url === undefined ? 'This artifact has no source link' : artifact.url}
            onClick={() => artifact.url !== undefined && onOpenSource(artifact.url)}
            className="flex h-9 flex-none cursor-pointer items-center gap-2 rounded-button-sm border border-line bg-raised px-3 text-label whitespace-nowrap text-text [font:inherit] hover:bg-surface-2 disabled:cursor-default disabled:text-dim disabled:hover:bg-raised"
          >
            <Icon icon={LinkSquare01Icon} size={16} className="flex-none" />
            Open original
          </button>
          {/* Always here, even when this one is already in the chat on screen: the
              menu marks that room "Already there" and aims at the next one, where
              hiding the control left the only way to another chat off the panel. */}
          <AddToChatButton
            destinations={destinations}
            contextIds={[artifactContextId(artifact.id)]}
            size="sm"
            drop="up"
            onAdd={onAdd}
          />
        </div>
        {/* Said out loud rather than left as a surprise: the tray in the grid keeps
            waiting while this panel sends the one object it is about. */}
        {!otherSelection ? null : (
          <p className="m-0 flex-none border-t border-line bg-raised px-4 pb-3 text-meta text-dim">
            Sends this one. Your selection in the grid stays as it is.
          </p>
        )}
      </div>
    </Dialog>
  )
}

/**
 * A saved post, drawn as one. The words sit in a card of their own with the author
 * and the date under them, the way the post was read where it was found; a bare
 * paragraph on a dark wall loses that it was ever somebody speaking.
 */
function XPostCard({ artifact, body }: { artifact: MyMindArtifact; body: string }) {
  const handle = xPostHandle(artifact.url)
  return (
    <article className="flex max-h-full w-full max-w-[580px] flex-col overflow-hidden rounded-xl border border-line bg-surface">
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <p className="m-0 text-[15px] leading-[1.7] whitespace-pre-wrap text-text">{plainText(body)}</p>
      </div>
      <div className="flex flex-none items-center justify-between gap-3 border-t border-line px-5 py-3 text-meta text-dim">
        <span className="min-w-0 truncate">
          {handle === undefined ? 'Post on X' : `Post by @${handle}`} on {formatDate(artifact.created)}
        </span>
        <Icon icon={NewTwitterIcon} size={14} className="flex-none" />
      </div>
    </article>
  )
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return undefined
  }
}
