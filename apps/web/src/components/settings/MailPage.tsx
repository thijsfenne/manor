import { SIDE_CHAT_DEFAULTS, type AgentConfig, type HouseSettings } from '@manor/contracts'
import { cosOf } from '../../persona'
import { activeModel } from '../../runtimeChoices'
import { SideRuntimeMenu } from '../SideRuntimeMenu'
import { SettingsGroup, SettingsPage, SettingsRow } from './SettingsLayout'

/**
 * What writes reply drafts in Mail. Null keeps following the default agent's own model and
 * effort, so a pick equal to them is saved as null and a later change to the agent carries over.
 */
export function MailPage({ settings, agents, onSave }: {
  /** Null until the server has sent them. */
  settings: HouseSettings | null
  agents: AgentConfig[]
  onSave: (settings: HouseSettings) => void
}) {
  const cos = cosOf(agents)
  const cosModel = cos === null ? undefined : activeModel(cos, {})
  const own = cos === null || cosModel === undefined ? null : { model: cosModel, effort: cos.effort }
  const shown = own ?? SIDE_CHAT_DEFAULTS
  return (
    <SettingsPage title="Mail">
      <SettingsGroup title="Replies">
        <SettingsRow label="Reply draft model" description="Writes reply drafts in Mail, in your default agent's voice. Runs without tools.">
          <SideRuntimeMenu
            model={settings?.mailDraftModel ?? shown.model}
            effort={settings?.mailDraftEffort ?? shown.effort}
            disabled={settings === null || own === null}
            defaults={shown}
            drop="down"
            title="Provider, model and reasoning for mail reply drafts"
            onChange={(model, effort) => {
              if (settings === null || own === null) return
              const following = model === own.model && effort === own.effort
              onSave({ ...settings, mailDraftModel: following ? null : model, mailDraftEffort: following ? null : effort })
            }}
          />
        </SettingsRow>
      </SettingsGroup>
    </SettingsPage>
  )
}
