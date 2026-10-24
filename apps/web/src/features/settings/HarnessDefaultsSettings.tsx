import { operatorChatSettings, type AgentHarness, type HarnessDefaults } from '@foreman-code/contracts'
import type { HarnessSettingsSection } from '@foreman-code/contracts/management'
import { Alert, Button, Dialog, ErrorState, LoadingState, Switch } from '../../shared/ui/nocturne'
import { useOperatorSettings } from '../operator-chat/useOperatorSettings'
import { useManagedHarnessCatalogQuery, useUpdateManagedHarnessDefaultsMutation } from '../../shared/api/query'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import { askOperator } from '../operator-chat/operatorChatStore'
import { SettingsChoice, SettingsOverview } from './SettingsCards'
import { harnessNames, harnessSummary } from './settingsPresentation'
import { useRevisionedForm, type Snapshot } from './revisionedForm'
import { ClaudeMcpConfiguration } from './ClaudeMcpConfiguration'
import { ClaudePluginSummary } from './ClaudePluginSummary'
import { CodexPluginManager } from './CodexPluginManager'
import { HarnessMcpManager } from './HarnessMcpManager'
import { SettingsFormActions, SettingsFormFeedback } from './SettingsFormActions'
import { OperatorMcpStatus } from './OperatorMcpStatus'
import { ProviderAccountComputerSelect, ProviderAccountsSettings, type ProviderAccountNavigation } from '../provider-accounts'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'

/** Harnesses this app runs: Codex and Claude. */
const HARNESSES = ['codex', 'claude'] as const
type Harness = typeof HARNESSES[number]

function useProviderDefaults() {
  const catalogQuery = useManagedHarnessCatalogQuery(true)
  const codex = catalogQuery.data?.find((entry) => entry.harness === 'codex')
  const claude = catalogQuery.data?.find((entry) => entry.harness === 'claude')
  const incoming = codex?.defaults.harness === 'codex' && (!claude || (claude.defaults.harness === 'claude' && claude.defaultsRevision === codex.defaultsRevision))
    ? { value: { codex: codex.defaults, ...(claude?.defaults.harness === 'claude' ? { claude: claude.defaults } : {}) } as HarnessDefaults, revision: codex.defaultsRevision }
    : undefined
  return { incoming, query: catalogQuery }
}

function ProviderCard({ harness, value, revision, readiness, onOpen, accountSelection, onAccountSelect,
  accountTarget, operator }: {
  harness: Harness; value?: HarnessDefaults | undefined; revision?: number | undefined; readiness: string
  operator: ReturnType<typeof useOperatorSettings>
  onOpen(section: 'connections' | 'plugins'): void
  accountSelection?: ProviderAccountNavigation | undefined
  onAccountSelect?: ((selection: ProviderAccountNavigation | undefined) => void) | undefined
  accountTarget?: DeviceProvisioningTarget | undefined
}) {
  const name = harnessNames[harness]
  const preset = value?.[harness]
  const summary = [...(preset ? harnessSummary(preset).filter((item) => item.label !== 'Harness') : [{ label: 'Preset', value: 'Not configured' }]),
    { label: 'Status', value: readiness }]
  return <SettingsChoice icon="settings" title={name} summary={summary}
    onSelect={() => askOperator(`Change the ${name} preset: `, { send: false })}
    footer={<>
      <div className="harness-card-controls">
      <Switch label="Operator default" checked={operator.harness?.harness === harness}
        disabled={!preset || !operator.settings || operator.harness?.harness === harness || operator.form.isSaving || operator.form.uncertain}
        onChange={(event) => { if (event.target.checked && preset) operator.change(operatorChatSettings(preset, operator.settings?.showThinking ?? false)) }} />
      {value && revision !== undefined ? <OperatorMcpStatus harness={harness} defaults={value} revision={revision} /> : null}
      <span className="settings-choice-links">
        <Button size="sm" variant="ghost" onClick={() => onOpen('connections')}>Connections</Button>
        <Button size="sm" variant="ghost" onClick={() => onOpen('plugins')}>Plugins</Button>
      </span>
      </div>
      <ProviderAccountsSettings provider={harness} selection={accountSelection} onSelect={onAccountSelect}
        target={accountTarget} />
    </>} />
}

/** Harness presets and plugin changes are managed by the Operator. */
export function HarnessDefaultsSettings({ selectedHarness, section, onOpen, accountSelection, onAccountSelect,
  accountTarget, onAccountTargetChange }: {
  selectedHarness?: AgentHarness | undefined; section?: HarnessSettingsSection | undefined
  accountSelection?: ProviderAccountNavigation | undefined
  onAccountSelect?: ((selection: ProviderAccountNavigation | undefined) => void) | undefined
  accountTarget?: DeviceProvisioningTarget | undefined
  onAccountTargetChange?: ((target: DeviceProvisioningTarget) => void) | undefined
  onOpen?(next: { harness: Harness; section: 'connections' | 'plugins' } | undefined): void
}) {
  const { incoming, query } = useProviderDefaults()
  const operator = useOperatorSettings(true)
  const accessError = useProtectedAccessError(query)
  const dialog = selectedHarness && section ? section : undefined
  const dialogName = selectedHarness === 'claude' ? 'Claude' : 'Codex'
  const readiness = (harness: Harness) => {
    const entry = query.data?.find((item) => item.harness === harness)
    // The full discovery message stays in the value's tooltip; the card shows the state in a word or two.
    if (entry?.discoveryError) return /sign/i.test(entry.discoveryError.message) ? 'Signed out' : 'Unavailable'
    return !entry ? 'Not configured' : entry.capability ? 'Ready' : 'Checking…'
  }
  let overview
  if (accessError || (!incoming && (query.isError || query.isSuccess))) {
    overview = <ErrorState title="Harness defaults are unavailable"
      description={accessError?.message ?? query.error?.message ?? 'The server returned an incomplete provider catalog.'}
      onRetry={() => void query.refetch()} />
  } else if (!incoming) {
    overview = <LoadingState label="Loading harness defaults…" />
  } else {
    overview = query.isError ? <Alert tone="warning" title="Harness defaults couldn't update"
      action={<Button size="sm" onClick={() => void query.refetch()}>Retry defaults</Button>}>Showing the last saved presets.</Alert> : null
  }
  return <>
    {overview}
    <SettingsFormFeedback form={operator.form} />
    {operator.form.isDirty ? <p role="status">Operator default has unsaved changes. The switches show your selection.</p> : null}
    <SettingsFormActions form={operator.form} onSave={operator.save} saveLabel="Save Operator default" />
    {onAccountTargetChange ? <ProviderAccountComputerSelect target={accountTarget} onChange={onAccountTargetChange} /> : null}
    <SettingsOverview title="Harnesses">
      {HARNESSES.map(harness => <ProviderCard key={harness} harness={harness} value={incoming?.value} operator={operator}
        revision={incoming?.revision} readiness={readiness(harness)} accountSelection={accountSelection}
        accountTarget={accountTarget}
        onAccountSelect={onAccountSelect} onOpen={next => onOpen?.({ harness, section: next })} />)}
    </SettingsOverview>
    <Dialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) onOpen?.(undefined) }} size="lg"
      title={`${dialogName} ${dialog ?? ''}`}>
      {dialog === 'plugins' && selectedHarness === 'claude' ? <ClaudePluginSummary accessUnavailable={Boolean(accessError)}
        onClose={() => onOpen?.(undefined)} /> : null}
      {dialog === 'plugins' && selectedHarness === 'codex' ? <CodexPluginManager accessUnavailable={Boolean(accessError)} /> : null}
      {dialog === 'connections' && selectedHarness === 'codex' ? <HarnessMcpManager harness="codex" accessUnavailable={Boolean(accessError)} /> : null}
      {dialog === 'connections' && selectedHarness === 'claude' ? <ClaudeConnections incoming={incoming} unavailable={Boolean(accessError)} /> : null}
      {dialog && dialog !== 'plugins' && dialog !== 'connections' ? <>
        <p>{dialogName} preset changes are managed by the Operator. This section now opens a contextual request.</p>
        <Button onClick={() => { onOpen?.(undefined); askOperator(`Change the ${dialogName} preset ${dialog}: `, { send: false }) }}>
          Edit {dialogName} defaults with Operator</Button>
      </> : null}
    </Dialog>
  </>
}


function ClaudeConnections({ incoming, unavailable }: { incoming: Snapshot<HarnessDefaults> | undefined; unavailable: boolean }) {
  const form = useRevisionedForm(incoming, 'harness:claude:connections')
  const mutation = useUpdateManagedHarnessDefaultsMutation()
  const save = () => form.save(async ({ value, ...request }) => {
    const result = await mutation.mutateAsync({ ...request, defaults: value })
    return { value: result.value.defaults, revision: result.value.revision }
  })
  if (unavailable) return <p role="alert">Claude connections are unavailable. Restore access and retry defaults.</p>
  const value = form.draft?.claude
  if (!value) return <p role="status">Configure a Claude preset with the Operator before adding connections.</p>
  return <>
    <fieldset disabled={form.isSaving || form.uncertain}>
      <ClaudeMcpConfiguration value={value} onChange={claude => form.setDraft(current => current ? { ...current, claude } : current)} />
    </fieldset>
    <SettingsFormFeedback form={form} />
    <SettingsFormActions form={form} onSave={save} saveLabel="Save Claude connections" />
  </>
}
