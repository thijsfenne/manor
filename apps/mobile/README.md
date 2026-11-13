# Manor mobile

The native Expo client for Manor. It connects to the existing Manor server over
WebSocket and reuses the shared contracts, state reducer, and connection runtime.

## Local setup

Create `apps/mobile/.env.local` with the Tailscale WebSocket endpoint of the Manor
server. Auth uses that same host over HTTPS. No database credentials belong on the
phone.

```dotenv
EXPO_PUBLIC_MANOR_WS=wss://your-manor-host.tailnet.ts.net/ws
```

The phone signs in with the password account of your Manor. A new install has none,
because the desktop app on the Mac needs no account. Create it once on the Mac, from
the repository root. The command asks for the password and does not echo it.

```bash
pnpm --filter @manor/server account you@example.com
```

Run it again to change the email or the password. No device connects again without the
new password. A connection that is open at that moment lasts until it drops, so restart
Manor to close it at once. `account --remove` deletes the account, and then only the Mac
opens Manor.

Then start Expo from the repository root.

```bash
pnpm --filter @manor/mobile start
```

Manor now needs a custom development client because remote notifications are not in
Expo Go. A local `pnpm --filter @manor/mobile ios` build is enough for ordinary native
development; configure the Expo project's APNs/FCM credentials before testing push
delivery (`eas credentials --platform ios` or `--platform android`).

The Mac still hosts Manor and must be awake and reachable through Tailscale. The
PWA remains the fallback client. The server sends completion pushes through Expo;
the app suppresses them while it is in front and opens the named chat when tapped.
