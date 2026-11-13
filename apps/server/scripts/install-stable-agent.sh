#!/bin/bash
# Writes the launch agent that keeps the stable Manor server on 43179. The agent only
# serves: the web build and the install happen in `stable-restart.sh`, where a failure
# is visible and leaves the running server alone, instead of inside a KeepAlive loop.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
pnpm_bin="$(command -v pnpm)"
node_dir="$(dirname "$(command -v node)")"
# launchd PATH is /usr/bin:/bin. Hermes pnpm is `#!/usr/bin/env node`.
launch_path="${node_dir}:${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
plist="$HOME/Library/LaunchAgents/com.thijsfenne.manor.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.thijsfenne.manor</string>
  <key>WorkingDirectory</key>
  <string>${repo}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${launch_path}</string>
    <key>MANOR_ROUTINES</key>
    <string>on</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>${pnpm_bin}</string>
    <string>stable:serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${HOME}/Library/Logs/manor.log</string>
  <key>StandardErrorPath</key>
  <string>${HOME}/Library/Logs/manor.err.log</string>
</dict>
</plist>
EOF
echo "Wrote ${plist}"
echo "Load it with: pnpm stable:restart"
