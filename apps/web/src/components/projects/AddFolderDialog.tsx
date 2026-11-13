import { useState } from 'react'
import type { DirBrowse } from '../../state'
import { Modal } from '../Modal'
import { RequestNotice } from '../ui/RequestNotice'
import { Picker } from './ProjectDialog'

/**
 * Add folder where Finder is not at hand (plain web, the phone's browser) or where the
 * add was refused: the server's own folder walk, the one the project form uses.
 */
export function AddFolderDialog({
  dirs,
  error,
  busy,
  onWalk,
  onPick,
  onClose,
}: {
  dirs: DirBrowse
  error: string | null
  busy: boolean
  onWalk: (path?: string) => void
  onPick: (path: string) => void
  onClose: () => void
}) {
  const [typed, setTyped] = useState('')
  return (
    <Modal title="Add folder" subtitle="A folder to work in. It gets no project thread." onClose={onClose}>
      <Picker
        dirs={dirs}
        typed={typed}
        onTyped={setTyped}
        onWalk={onWalk}
        onPick={(path) => {
          if (!busy) onPick(path)
        }}
        onDone={onClose}
      />
      {error === null ? null : <RequestNotice notice={{ kind: 'error', text: error }} />}
    </Modal>
  )
}
