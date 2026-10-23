import { useComputerActivity, computerKey } from '../../shared/api/computerActivity'
import { Button, SettingsSection, Skeleton } from '../../shared/ui/nocturne'
import { ComputerSyncPanel } from '../computers'
import { ChatRetentionSettings } from '../retention-settings'
import './settingsExperience.css'
import './generalSettings.css'

/** General settings (chat files, file sync): one section per concern, each a row of label + control; loading keeps the rows' shape. */
export function GeneralSettings() {
  const computers = useComputerActivity()
  return <section className="settings-editor-page general-settings" aria-label="General settings">
    <header className="settings-experience-heading"><h1>General</h1></header>
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
