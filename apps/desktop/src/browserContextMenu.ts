import { clipboard, Menu, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { stopBrowserInput } from './browserInputAction'

/**
 * A webview guest has no native context menu; Chromium leaves it to the embedder.
 * This is the page's right click: link, image, edit and navigation items.
 * A link opens the way a popup does, as a new tab behind the current one.
 */
export function attachContextMenu(contents: WebContents, openLink: (url: string) => void): void {
  contents.on('context-menu', (_event, params) => {
    Menu.buildFromTemplate(contextMenuTemplate(params, contents, openLink)).popup()
  })
}

export function contextMenuTemplate(
  params: Pick<ContextMenuParams, 'linkURL' | 'srcURL' | 'mediaType' | 'selectionText' | 'isEditable' | 'editFlags' | 'misspelledWord' | 'dictionarySuggestions' | 'x' | 'y'>,
  contents: WebContents,
  openLink: (url: string) => void,
): MenuItemConstructorOptions[] {
  const groups: MenuItemConstructorOptions[][] = []
  if (params.isEditable && params.misspelledWord !== '') {
    groups.push(params.dictionarySuggestions.length > 0
      ? params.dictionarySuggestions.slice(0, 5).map((word) => ({ label: word, click: () => contents.replaceMisspelling(word) }))
      : [{ label: 'No spelling suggestions', enabled: false }])
  }
  if (/^https?:/i.test(params.linkURL)) {
    groups.push([
      { label: 'Open link in new tab', click: () => openLink(params.linkURL) },
      { label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) },
    ])
  }
  if (params.mediaType === 'image' && params.srcURL !== '') {
    groups.push([
      { label: 'Copy image', click: () => contents.copyImageAt(params.x, params.y) },
      { label: 'Copy image address', click: () => clipboard.writeText(params.srcURL) },
    ])
  }
  if (params.isEditable) {
    groups.push([
      { label: 'Cut', enabled: params.editFlags.canCut, click: () => contents.cut() },
      { label: 'Copy', enabled: params.editFlags.canCopy, click: () => contents.copy() },
      { label: 'Paste', enabled: params.editFlags.canPaste, click: () => contents.paste() },
      { label: 'Select all', enabled: params.editFlags.canSelectAll, click: () => contents.selectAll() },
    ])
  } else if (params.selectionText.trim() !== '') {
    groups.push([{ label: 'Copy', click: () => contents.copy() }])
  }
  if (groups.length === 0) {
    const history = contents.navigationHistory
    groups.push([
      { label: 'Back', enabled: history.canGoBack(), click: () => history.goBack() },
      { label: 'Forward', enabled: history.canGoForward(), click: () => history.goForward() },
      { label: 'Reload', click: () => contents.reload() },
    ])
  }
  groups.push([{
    label: 'Inspect element',
    click: () => {
      void stopBrowserInput(contents).finally(() => {
        contents.openDevTools({ mode: 'detach' })
        contents.inspectElement(params.x, params.y)
      })
    },
  }])
  return groups.flatMap((group, index) => index === 0 ? group : [{ type: 'separator' as const }, ...group])
}
