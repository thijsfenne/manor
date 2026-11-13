#!/bin/bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
pnpm_bin="$(command -v pnpm)"
node_dir="$(dirname "$(command -v node)")"
# launchd PATH is /usr/bin:/bin. Hermes pnpm is `#!/usr/bin/env node`.
launch_path="${node_dir}:${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
plist="$HOME/Library/LaunchAgents/com.thijsfenne.manor-backup.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.thijsfenne.manor-backup</string>
  <key>WorkingDirectory</key>
  <string>${repo}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${launch_path}</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>${pnpm_bin}</string>
    <string>--filter</string>
    <string>@manor/server</string>
    <string>backup:sqlite</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>4</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${HOME}/.manor/backups/backup.log</string>
  <key>StandardErrorPath</key>
  <string>${HOME}/.manor/backups/backup.log</string>
</dict>
</plist>
EOF
mkdir -p "$HOME/.manor/backups"
echo "Wrote ${plist}"
echo "Load it with: launchctl bootstrap gui/\$(id -u) ${plist}"
