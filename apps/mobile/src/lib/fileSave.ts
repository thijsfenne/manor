import { Directory, File, Paths } from 'expo-file-system'
import { Share } from 'react-native'

export const FILE_GONE = 'This file is no longer available in Manor.'
export const FILE_UNREACHABLE = 'Manor cannot be reached right now. Try again once the connection is back.'

/** The failure a download or a read shows, in one short line. */
export function fileFailure(failure: unknown): string {
  const message = failure instanceof Error ? failure.message : ''
  if (message === FILE_GONE || /\b404\b/.test(message)) return FILE_GONE
  return /\b\d{3}\b/.test(message) ? 'Manor could not fetch the file.' : FILE_UNREACHABLE
}

/**
 * Downloads a file to the cache and hands the copy to the share sheet, where Save to
 * Files lives. `key` names the file's own cache folder. Throws on failure.
 */
export async function saveToShareSheet(uri: string, key: string, name: string): Promise<void> {
  const folder = new Directory(Paths.cache, 'manor-files', key.replace(/[^\w.-]/g, '_'))
  folder.create({ intermediates: true, idempotent: true })
  const saved = await File.downloadFileAsync(uri, new File(folder, name), { idempotent: true })
  await Share.share({ url: saved.uri })
}
