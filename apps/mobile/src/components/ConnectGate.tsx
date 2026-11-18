import { NOT_A_PAIRING_LINK } from '@manor/client-runtime/pairing'
import { parsePairingLink } from '@manor/contracts'
import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon'
import { requireOptionalNativeModule } from 'expo'
import * as Clipboard from 'expo-clipboard'
import { useRef, useState, type ReactNode } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  TextInput,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { CardButton } from '@/components/CardButton'
import { GlassIconButton } from '@/components/GlassIconButton'
import { Text } from '@/components/Text'
import { useConnection } from '@/providers/ConnectionProvider'
import { colors, fonts, radius, spacing, squircle, tracking } from '@/theme'

const CAMERA_UNAVAILABLE = 'The camera is not available in this build. Paste the link instead.'
const CAMERA_DENIED = 'Manor cannot use the camera. Allow it in Settings, or paste the link instead.'
const SCAN_PAUSE_MS = 1_500

type CameraModule = typeof import('expo-camera')

/**
 * The camera module is read when it is first needed, and only when its native side is
 * in this build: a development client built before the camera was added lacks it, and
 * loading the module there reports a fatal error before any catch can see it.
 */
function loadCamera(): CameraModule | null {
  if (requireOptionalNativeModule('ExpoCamera') === null) return null
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-camera') as CameraModule
}

/** Shows the app once a Mac is connected, and the way to connect to one until then. */
export function ConnectGate({ children }: { children: ReactNode }) {
  const connection = useConnection()
  const [mode, setMode] = useState<'home' | 'paste' | 'scan'>('home')
  const [pairing, setPairing] = useState<'scan' | 'paste' | 'link' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [link, setLink] = useState('')
  const [camera, setCamera] = useState<CameraModule | null>(null)
  const rejected = useRef<string | null>(null)

  if (!connection.ready) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    )
  }

  if (connection.devServer !== null || connection.credential !== null) return children

  const pair = async (text: string, source: 'scan' | 'paste' | 'link') => {
    setPairing(source)
    setError(null)
    const failure = await connection.pair(text)
    setError(failure)
    setPairing(null)
  }

  const openCamera = async () => {
    setError(null)
    const loaded = loadCamera()
    if (loaded === null) {
      setError(CAMERA_UNAVAILABLE)
      return
    }
    try {
      const permission = await loaded.Camera.requestCameraPermissionsAsync()
      if (!permission.granted) {
        setError(CAMERA_DENIED)
        return
      }
    } catch {
      setError(CAMERA_UNAVAILABLE)
      return
    }
    rejected.current = null
    setCamera(loaded)
    setMode('scan')
  }

  const scanned = (data: string) => {
    if (pairing !== null || data === rejected.current) return
    if (parsePairingLink(data) === null) {
      rejected.current = data
      setError(NOT_A_PAIRING_LINK)
      setTimeout(() => { rejected.current = null }, SCAN_PAUSE_MS)
      return
    }
    setMode('home')
    void pair(data, 'scan')
  }

  const readClipboard = async () => {
    try {
      const text = await Clipboard.getStringAsync()
      if (text.trim() !== '') setLink(text.trim())
    } catch {
      // The field stays empty; the link can still be typed or pasted into it.
    }
  }

  const incoming = connection.incomingLink

  if (mode === 'scan' && camera !== null && incoming === null) {
    const { CameraView } = camera
    return (
      <View style={styles.cameraRoot}>
        <CameraView
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          facing="back"
          onBarcodeScanned={({ data }) => scanned(data)}
          style={StyleSheet.absoluteFill}
        />
        <SafeAreaView style={styles.cameraOverlay}>
          <View style={styles.cameraTop}>
            <GlassIconButton
              accessibilityLabel="Cancel"
              icon={Cancel01Icon}
              onPress={() => { setError(null); setMode('home') }}
            />
          </View>
          {error === null ? null : <Text style={styles.cameraError}>{error}</Text>}
        </SafeAreaView>
      </View>
    )
  }

  const busy = pairing !== null

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.flex}
    >
      <SafeAreaView style={styles.connect}>
        <View style={styles.heading}>
          <Text style={styles.title}>Connect to your Mac</Text>
          <Text style={styles.subtitle}>
            {incoming === null
              ? 'In Manor on your Mac, open Settings → Phone and choose Pair phone.'
              // A link from outside the app could name someone else's server, so the
              // person confirms the exact address before the phone contacts it.
              : `Connect this phone to ${incoming.origin}? Only continue if you just made this code on your Mac.`}
          </Text>
        </View>
        <View style={styles.form}>
          {connection.notice === null ? null : <Text style={styles.notice}>{connection.notice}</Text>}
          {incoming !== null ? (
            <>
              <CardButton
                busy={pairing === 'link'}
                disabled={busy}
                label={pairing === 'link' ? 'Connecting…' : 'Connect'}
                onPress={() => void pair(incoming.link, 'link')}
                style={styles.button}
                variant="primary"
              />
              <CardButton
                disabled={busy}
                label="Cancel"
                onPress={() => { setError(null); connection.dismissIncoming() }}
                style={styles.button}
                variant="quiet"
              />
            </>
          ) : mode === 'paste' ? (
            <>
              <TextInput
                accessibilityLabel="Paste the pairing link"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                onChangeText={setLink}
                onSubmitEditing={() => void pair(link, 'paste')}
                placeholder="Paste the pairing link"
                placeholderTextColor={colors.dim}
                style={styles.input}
                value={link}
              />
              <CardButton
                busy={pairing === 'paste'}
                disabled={busy || link.trim() === ''}
                label={pairing === 'paste' ? 'Connecting…' : 'Connect'}
                onPress={() => void pair(link, 'paste')}
                style={styles.button}
                variant="primary"
              />
              <CardButton
                disabled={busy}
                label="Use copied link"
                onPress={() => void readClipboard()}
                style={styles.button}
              />
              <CardButton
                disabled={busy}
                label="Back"
                onPress={() => { setError(null); setMode('home') }}
                style={styles.button}
                variant="quiet"
              />
            </>
          ) : (
            <>
              <CardButton
                busy={pairing === 'scan'}
                disabled={busy}
                label={pairing === 'scan' ? 'Connecting…' : 'Scan QR'}
                onPress={() => void openCamera()}
                style={styles.button}
                variant="primary"
              />
              <CardButton
                disabled={busy}
                label="Paste link"
                onPress={() => { setError(null); setMode('paste') }}
                style={styles.button}
              />
            </>
          )}
          {error === null ? null : <Text style={styles.error}>{error}</Text>}
        </View>
      </SafeAreaView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  connect: { flex: 1, justifyContent: 'center', padding: spacing.xl, gap: 40, backgroundColor: colors.background },
  heading: { gap: spacing.sm },
  title: { color: colors.text, fontFamily: fonts.display, fontSize: 30, letterSpacing: -0.7 },
  subtitle: { color: colors.muted, fontFamily: fonts.sans, fontSize: 16, lineHeight: 23 },
  form: { gap: spacing.md },
  input: {
    minHeight: 52,
    borderRadius: radius.md,
    ...squircle,
    backgroundColor: colors.surface,
    color: colors.text,
    fontFamily: fonts.sans,
    fontSize: 16,
    letterSpacing: tracking.body,
    paddingHorizontal: spacing.lg,
  },
  notice: { color: colors.muted, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20 },
  error: { color: colors.danger, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  button: { alignSelf: 'stretch' },
  cameraRoot: { flex: 1, backgroundColor: colors.shadow },
  cameraOverlay: { flex: 1, justifyContent: 'space-between', padding: spacing.lg },
  cameraTop: { flexDirection: 'row', justifyContent: 'flex-start' },
  cameraError: {
    alignSelf: 'stretch',
    padding: spacing.md,
    borderRadius: radius.md,
    ...squircle,
    overflow: 'hidden',
    backgroundColor: colors.scrim,
    color: colors.lightControl,
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 20,
  },
})
