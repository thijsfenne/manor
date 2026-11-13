const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)

/**
 * The shared packages use NodeNext-compatible `.js` specifiers while publishing
 * TypeScript source inside this workspace. Metro does not apply TypeScript's normal
 * source substitution, so teach it the same local rule without weakening runtime
 * imports in Electron or the server.
 */
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    try {
      return context.resolveRequest(context, moduleName.slice(0, -3), platform)
    } catch {
      // The ordinary resolver below owns real JavaScript files.
    }
  }
  return context.resolveRequest(context, moduleName, platform)
}

/**
 * A development bundle reads the `.env*` files at runtime and lets them win over the
 * shell, so `EXPO_NO_DOTENV=1` alone still ships `.env.local` and its live socket. The
 * phone verify fixture sets that flag to stay off the live house. Expo watches those
 * files only through these extensions, so dropping them leaves the shell's values.
 */
if (process.env.EXPO_NO_DOTENV === '1') {
  config.watcher.additionalExts = config.watcher.additionalExts.filter((ext) => !['env', 'local', 'development'].includes(ext))
}

module.exports = config
