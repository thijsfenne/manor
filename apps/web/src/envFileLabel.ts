/**
 * How Settings names the file the server reads its keys from: the path the server
 * reported with the home folder as `~`, or a plain description for a server too old to say.
 */
export const envFileLabel = (envFile: string | undefined): string =>
  envFile === undefined ? 'the server’s .env file' : envFile.replace(/^\/Users\/[^/]+(?=\/|$)/, '~')
