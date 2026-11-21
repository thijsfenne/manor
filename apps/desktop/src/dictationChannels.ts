/**
 * The dictation bridge's channels. The sandboxed preload cannot import this module, so
 * it writes each literal out again and `smoke:preload` proves the two still agree.
 * `DICTATION_MODELS_CHANNEL` is both the push of model statuses and the pull of the
 * current list a new subscriber makes.
 */
export const DICTATION_MODELS_CHANNEL = 'manor:dictation:models'
export const DICTATION_DOWNLOAD_CHANNEL = 'manor:dictation:download'
export const DICTATION_CANCEL_CHANNEL = 'manor:dictation:cancel'
export const DICTATION_REMOVE_CHANNEL = 'manor:dictation:remove'
export const DICTATION_WARM_CHANNEL = 'manor:dictation:warm'
export const DICTATION_TRANSCRIBE_CHANNEL = 'manor:dictation:transcribe'
export const DICTATION_MICROPHONE_CHANNEL = 'manor:dictation:microphone'
export const DICTATION_MICROPHONE_SETTINGS_CHANNEL = 'manor:dictation:microphone-settings'
