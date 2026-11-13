import { NativeModule, requireOptionalNativeModule } from 'expo'

export type ImagePasteEvent =
  | { name: string; dataUrl: string; error?: never }
  | { name?: never; dataUrl?: never; error: 'too_large' }

type ImagePasteEvents = {
  onImagePaste(event: ImagePasteEvent): void
}

declare class ManorImagePasteNativeModule extends NativeModule<ImagePasteEvents> {
  setEnabled(enabled: boolean): void
}

const native = requireOptionalNativeModule<ManorImagePasteNativeModule>('ManorImagePaste')

export function setImagePasteEnabled(enabled: boolean): void {
  native?.setEnabled(enabled)
}

export function addImagePasteListener(listener: (event: ImagePasteEvent) => void): { remove(): void } {
  return native?.addListener('onImagePaste', listener) ?? { remove: () => undefined }
}
