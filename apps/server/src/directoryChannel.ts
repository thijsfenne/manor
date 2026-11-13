import { diffDirectory, type DirectoryMessage } from '@manor/contracts'

/**
 * How each socket receives the directory. A client that opened its socket with
 * `directory=patch` holds the last listing it was sent and gets every later one as a
 * `directory_patch` against it; any other client, such as an older phone build, gets
 * every listing whole. Every directory frame to a socket goes through `payload`, in
 * send order, so the listing recorded here is always the one that client holds.
 */
export interface DirectoryChannel {
  /** Reads the opt-in from the upgrade request's URL, which also carries the token: never log it. */
  connect(socket: object, requestUrl: string | undefined): void
  /** The frame that brings this socket to `message`, which it then holds. */
  payload(socket: object, message: DirectoryMessage): string
}

export function createDirectoryChannel(): DirectoryChannel {
  const patching = new WeakSet<object>()
  const held = new WeakMap<object, DirectoryMessage>()
  // A broadcast hands every socket the same listing, and sockets that heard the last
  // one share that base too, so each encoding is made once and reused by the rest.
  const whole = new WeakMap<DirectoryMessage, string>()
  const patches = new WeakMap<DirectoryMessage, WeakMap<DirectoryMessage, string>>()

  const encodeWhole = (message: DirectoryMessage) => {
    let text = whole.get(message)
    if (text === undefined) {
      text = JSON.stringify(message)
      whole.set(message, text)
    }
    return text
  }

  const encodePatch = (base: DirectoryMessage, next: DirectoryMessage) => {
    let fromBase = patches.get(base)
    if (fromBase === undefined) {
      fromBase = new WeakMap()
      patches.set(base, fromBase)
    }
    let text = fromBase.get(next)
    if (text === undefined) {
      text = JSON.stringify(diffDirectory(base, next))
      fromBase.set(next, text)
    }
    return text
  }

  return {
    connect(socket, requestUrl) {
      if (new URL(requestUrl ?? '/', 'http://manor.invalid').searchParams.get('directory') === 'patch') patching.add(socket)
    },
    payload(socket, message) {
      if (!patching.has(socket)) return encodeWhole(message)
      const base = held.get(socket)
      held.set(socket, message)
      return base === undefined ? encodeWhole(message) : encodePatch(base, message)
    },
  }
}
