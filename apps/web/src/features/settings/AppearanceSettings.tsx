import { Alert, Button, SegmentedControl, SettingRow, SettingsSection, Skeleton } from '../../shared/ui/nocturne'
import { useSyncedTheme } from '../theme'
import { ThemeSchema } from '@foreman-code/contracts/management'
import './settingsExperience.css'
import './generalSettings.css'

/** Appearance: the theme for now. */
export function AppearanceSettings() {
  const { settings, update, changeTheme, denied, uncertain, retry } = useSyncedTheme()
  return <section className="settings-editor-page general-settings" aria-label="Appearance settings">
    <header className="settings-experience-heading"><h1>Appearance</h1></header>
    <SettingsSection title="Theme" description="Dark or light, everywhere you open the app.">
      <SettingRow title="Color theme">
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
  </section>
}
