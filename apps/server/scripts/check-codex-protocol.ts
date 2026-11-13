import { codexCommandOverride, sharedCodexInstallation } from '../src/drivers/codexCommand.js'
import { checkCodexProtocol } from '../src/drivers/codexProtocol.js'

// The same binary the driver spawns: the active managed release, installed first if missing.
const command = codexCommandOverride() ?? await sharedCodexInstallation().ensure()
const result = await checkCodexProtocol(command)
if (!result.ok) {
  console.error(`Codex protocol incompatible: ${result.reason}`)
  process.exit(1)
}
console.log(`Codex protocol compatible. ${result.checked} schemas checked.`)
