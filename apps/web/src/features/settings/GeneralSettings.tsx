import { useComputerActivity, computerKey } from '../../shared/api/computerActivity'
import { Alert, Button, SegmentedControl, SettingRow, SettingsSection, Skeleton } from '../../shared/ui/nocturne'
import { ComputerSyncPanel } from '../computers/ComputerSync'
import { useSyncedTheme } from '../theme/useSyncedTheme'
import { ThemeSchema } from '@foreman-code/contracts/management'
import { ChatRetentionSettings } from '../retention-settings'
import './settingsExperience.css'
import './generalSettings.css'

/** General settings: one section per concern, each a row of label + control; loading keeps the rows' shape. */
export function GeneralSettings() {
  const { settings, update, changeTheme, denied, uncertain, retry } = useSyncedTheme()
  const computers = useComputerActivity()
  return <section className="settings-editor-page general-settings" aria-label="General settings">
    <header className="settings-experience-heading"><h1>General</h1></header>
    <SettingsSection title="Appearance">
      <SettingRow title="Theme" description="Applies on every computer you open the app from.">
        {settings.data && !denied ? <SegmentedControl label="Theme" value={settings.data.value.theme}
          options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]}
          onValueChange={(theme) => { if (!update.isPending) changeTheme(ThemeSchema.parse(theme)) }} />
          : settings.isError ? <Button size="sm" onClick={() => void settings.refetch()}>Retry</Button>
            : <Skeleton width="9rem" height="2rem" />}
      </SettingRow>
      {update.isError ? <Alert tone="warning" title={update.error.message}>
        {uncertain ? <Button size="sm" disabled={denied} onClick={retry}>Retry theme save</Button> : null}
      </Alert> : null}
    </SettingsSection>
    <SettingsSection title="Chat files" description="Temporary files attached in chats. Project files never expire.">
      <ChatRetentionSettings />
    </SettingsSection>
    <SettingsSection title="File sync" description="Workspace files kept in sync on each computer.">
      {computers.data && !computers.isError ? computers.data.computers.map(computer =>
        <div className="general-sync-row" key={JSON.stringify(computer.target)} aria-label={`Sync on ${computer.name}`} role="group">
          <div className="general-sync-name">
            <span className="general-sync-dot" data-online={computer.online} aria-hidden="true" />
            <strong>{computer.name}</strong>
            <small>{computer.online ? 'Online' : 'Offline'}</small>
          </div>
          <ComputerSyncPanel key={computerKey(computer.target)} target={computer.target} online={computer.online} />
        </div>)
        : computers.isError ? <p className="general-note">Computers are unavailable right now.
          <Button size="sm" variant="ghost" onClick={() => void computers.refetch()}>Retry</Button></p>
          : [0, 1].map(index => <Skeleton key={index} width="100%" height="3rem" />)}
    </SettingsSection>
  </section>
}
