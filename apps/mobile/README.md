# Manor mobile

The native Expo client for Manor. It connects to the existing Manor server over
WebSocket and reuses the shared contracts, state reducer, and connection runtime.

## Connect to your Mac

The phone finds its Mac by pairing, once. Nothing about the Mac is built into the app.

1. Install Tailscale on the Mac and on the phone, and sign in to the same tailnet on both.
   The tailnet needs MagicDNS and HTTPS certificates (Tailscale admin console, DNS).
2. Open the Manor app on the phone. It shows Connect to your Mac.
3. On the Mac, open Settings → Phone, turn on Tailscale HTTPS and choose Make link.
   Scan the QR code with the phone, or paste the link.

Tailscale HTTPS runs `tailscale serve` for Manor's own port, so only devices in your
tailnet reach it. Manor never uses Funnel. The pairing link works once, for 10 minutes.
The phone keeps its device token in the iOS Keychain; the Mac keeps only a hash of it.

Settings → Phone lists the paired devices. Revoke closes that device's connection at
once, and the phone goes back to Connect to your Mac. Forget this Mac in the phone's
menu does the same from the phone. Opening the pairing link in a phone browser pairs
that browser instead, for the web app.

## Development

A development build can skip pairing and talk to a server on this machine, as the
verify fixture does. Put this in `apps/mobile/.env.local`; release builds ignore it.

```dotenv
EXPO_PUBLIC_MANOR_DEV_SERVER=http://127.0.0.1:43180
```

Then start Expo from the repository root.

```bash
pnpm --filter @manor/mobile start
```

Manor now needs a custom development client because remote notifications are not in
Expo Go. A local `pnpm --filter @manor/mobile ios` build is enough for ordinary native
development; configure the Expo project's APNs/FCM credentials before testing push
delivery (`eas credentials --platform ios` or `--platform android`).

The Mac still hosts Manor and must be awake and reachable through Tailscale. The
web app remains the fallback client. The server sends completion pushes through Expo;
the app suppresses them while it is in front and opens the named chat when tapped.
