import { spawn } from 'node:child_process'
import { resolveCodexComputer } from './codexComputerLaunch.js'

/**
 * The `codex-computer` row's process: starts the ChatGPT app's Codex computer-use
 * engine (`cua_repl`) with the newest installed plugin and only the env it needs, and
 * hands it this process's stdio. Manor's effect proxy sits in front, so the model sees
 * only the allowlisted tools and the first call of a turn asks to borrow the Mac.
 */
try {
  const launch = resolveCodexComputer(process.env)
  const child = spawn(launch.command, launch.args, { env: launch.env, stdio: 'inherit' })
  const forward = (signal: NodeJS.Signals) => { child.kill(signal) }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, forward)
  child.on('error', (error) => {
    process.stderr.write(`[codex-computer] could not start Codex computer use ${launch.version}: ${error.message}\n`)
    process.exitCode = 1
  })
  child.on('close', (code) => { process.exitCode = code ?? 1 })
} catch (error: unknown) {
  process.stderr.write(`[codex-computer] ${error instanceof Error ? error.message : 'could not start'}\n`)
  process.exitCode = 1
}
