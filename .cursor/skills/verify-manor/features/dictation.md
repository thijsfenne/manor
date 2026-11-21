# Dictation

The composer of the desktop app has a microphone button left of send. A press records, the button becomes a pill with a live waveform and ✕, with ✓ beside it; ✓ transcribes and puts the text at the caret, ✕ or Escape discards, and nothing is ever sent. The speech model runs in the Electron shell, so the headless spike shows the states through a stub and no real transcription happens there. Settings → Voice holds the models, the language and the microphone.

## Sub-features

- `dictation-idle`: the microphone beside send, with an empty and a filled composer.
- `dictation-first-use`: a press with the active model not on disk offers the download, with progress, Cancel, Retry and a `Voice settings` link.
- `dictation-record`: the pill with the waveform and ✕, the ✓ button, `Transcribing…`, the text at the caret.
- `dictation-cancel`: ✕ and Escape, while recording and while transcribing.
- `dictation-errors`: a failed transcription, no speech, a refused microphone.
- `voice-settings`: the model rows and their states, Use and Remove, Language with its note, Microphone.

## How to get to it (user POV)

- Open any chat or the home page and press the microphone in the composer.
- Press ⌘, then `Voice` under Personal, or follow `Voice settings` in the composer's download offer.

## Driving it with control-manor

- Launch with the stub: `MANOR_VERIFY_INIT_SCRIPT=$PWD/.cursor/skills/verify-manor/stubs/desktop-dictation.js node .cursor/skills/verify-manor/control-manor.mjs launch`. Whisper Turbo starts not downloaded, Parakeet ready. The spike's own settings start with Whisper Turbo active, so the first press is the first-use offer.
- **First use.** `click --role button --name Dictate`. Expect dialog `Dictation` with `Whisper Turbo`, `1.0 GB`, `Download` and `Voice settings`. `click --role button --name Download` shows a percent, a progress bar and `Cancel` for about four seconds, then `Whisper Turbo is ready. Press the microphone to dictate.`
- **Record.** `click --role button --name Dictate` again. Expect buttons `Cancel dictation` and `Insert dictation` and the unchanged send button. `click --role button --name "Insert dictation"` shows `Transcribing…` for 1.5 seconds, then the composer holds `Dit is een gedicteerde zin.` and no message was sent. `window.__manorDictation.transcribed` lists the model, language and seconds of each request.
- **Caret.** Type `Begin  einde`, put the caret between the words, dictate. Expect `Begin Dit is een gedicteerde zin. einde`.
- **Cancel.** While recording or transcribing, `click --role button --name "Cancel dictation"` or `press --key Escape`. The composer keeps its text and the microphone is back.
- **Errors.** Chords set the next outcome: `press --key Control+Alt+Shift+1` makes the next transcription fail, `+3` makes it hear no speech, `+2` refuses the microphone (the notice has `Open System Settings`; `window.__manorDictation.openedSettings` counts the presses), `+4` fails the next download, `+0` resets.
- **Settings.** `press --key "Meta+,"`, `click --role button --name Voice`. Rows `Whisper Turbo` and `Parakeet TDT 0.6B v3` with `Download`, a percent with `Cancel`, `In use`, `Use`, `Remove`, or an error with `Retry`. `click --role combobox --name Language`, then an option; with Parakeet in use and a fixed language the note says the choice only applies to Whisper Turbo. `click --role combobox --name Microphone` lists `System default`, `Built-in Microphone` and `Desk Microphone`. A reload keeps all three choices.
- `scheme --value dark` before a screenshot for the dark theme.

## Gotchas

- The selects are `combobox`, not `button`; a click by role `button` times out.
- `fill --composer --value ""` types the word `true`. Clear the composer with select all and Backspace.
- The stub's microphone is a synthetic tone, so the waveform moves but nothing is recognized. Real speech needs the Electron shell: start it with Playwright's `_electron` against the spike (`MANOR_DESKTOP_URL=http://127.0.0.1:<port>/`, its own `--user-data-dir`), with `--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<16 kHz mono wav>%noloop --disable-features=AudioServiceSandbox,AudioServiceOutOfProcess`. Without the last flag the sandboxed audio service cannot read the file and the recording is silent, which the app reports as `No speech heard.`
- After the file ends, the fake microphone plays a loud tone. Stop the recording before the clip ends; Parakeet returns nothing for a recording that ends in that tone.
- The models live in `<user-data-dir>/dictation-models/<model id>/`. Copy model files there to skip a 1 GB download; a file counts once its size matches the catalogue.
- Without the bridge (a browser tab) the composer has no microphone and Settings → Voice says dictation works in the desktop app.
