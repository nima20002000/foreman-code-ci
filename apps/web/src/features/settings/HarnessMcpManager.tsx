import { INSTALLATION_NAMES } from '@foreman-code/contracts/installation-names'
import { InfoHint } from '../../shared/ui/InfoHint'
import { UnsavedChangesContext, useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { useContext, useEffect, useRef, useState } from 'react'
import {
  HarnessMcpChangeSchema, type HarnessMcpChange, type HarnessMcpList, type HarnessMcpPlan, type HarnessMcpManagedPreset, type HarnessMcpReconcileInput,
} from '@foreman-code/contracts/management'
import { Alert, Button, Checkbox, Icon, Select, StatusBadge, Textarea, TextField } from '../../shared/ui/nocturne'
import {
  useNativeMcpServers, useNativeMcpPlans, useRequestNativeMcpChange, useDecideNativeMcpChange, useApplyManagedMcpChange, useHarnessSessionEpoch, useReconcileNativeMcpChange,
} from '../../shared/api/harnessSettings'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { APP_MCP_SERVER_NAMES } from '@foreman-code/contracts/product'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'

type Harness = 'codex'
type Presets = HarnessMcpList['presets']
/** Retired per-role app entries; installing the graphql preset removes them. */
const LEGACY_APP_SERVERS = [INSTALLATION_NAMES.mcp.app, INSTALLATION_NAMES.mcp.operator]
function needsAttention(name: string, presets: Presets): boolean {
  return (APP_MCP_SERVER_NAMES.some((server) => server === name) && ['mismatch', 'legacy'].includes(presets?.[INSTALLATION_NAMES.mcp.server] ?? ''))
    || (LEGACY_APP_SERVERS.includes(name) && presets?.[INSTALLATION_NAMES.mcp.server] !== undefined)
    || (name === 'linear' && presets?.linear === 'mismatch')
}
const words = { add: 'Add', remove: 'Remove', enable: 'Update' }
function ChangeDetails({ change }: { change: HarnessMcpChange }) {
  return <dl className="harness-change-details"><div><dt>Server</dt><dd>{change.name}</dd></div>
    <div><dt>Change</dt><dd>{change.kind === 'enable' ? change.enabled ? 'Enable' : 'Disable' : words[change.kind]}</dd></div>
    {change.kind === 'add' ? change.connection.transport === 'remote' ? <>
      <div><dt>URL</dt><dd>{change.connection.url}</dd></div>
      <div><dt>Authentication</dt><dd>{change.connection.bearerTokenEnvironmentVariable ? `Bearer token from ${change.connection.bearerTokenEnvironmentVariable}` : 'Sign in with Codex'}</dd></div>
    </> : <>
      <div><dt>Program</dt><dd>{change.connection.executable}</dd></div>
      <div><dt>Arguments</dt><dd>{change.connection.arguments.length ? <ol>{change.connection.arguments.map((argument, index) => <li key={index}><code>{argument || '(empty argument)'}</code></li>)}</ol> : 'None'}</dd></div>
      <div><dt>Environment variables</dt><dd>{change.connection.environmentVariables.join(', ') || 'None added'}</dd></div>
    </> : null}
  </dl>
}
function ConnectionForm({ busy, disabled, onReview }: {
  busy: boolean; disabled: boolean; onReview(change: HarnessMcpChange): void
}) {
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<'remote' | 'stdio'>('remote')
  const [url, setUrl] = useState('')
  const [variable, setVariable] = useState('')
  const [executable, setExecutable] = useState('')
  const [argumentsText, setArgumentsText] = useState('')
  const [environment, setEnvironment] = useState('')
  const [error, setError] = useState<string>()
  const review = () => {
    const candidate = HarnessMcpChangeSchema.safeParse({ kind: 'add', name: name.trim(), connection: transport === 'remote'
      ? { transport, url: url.trim(), ...(variable.trim() ? { bearerTokenEnvironmentVariable: variable.trim() } : {}) }
      : { transport, executable: executable.trim(), arguments: argumentsText === '' ? [] : argumentsText.split('\n'),
        environmentVariables: environment.split(/[,\s]+/).filter(Boolean) } })
    if (!candidate.success) {
      const field = String(candidate.error.issues[0]?.path.at(-1) ?? '')
      setError(({ name: 'Enter a server name (letters, numbers, - or _).', url: 'Enter a valid https URL.', bearerTokenEnvironmentVariable: 'Use a variable name like MY_TOKEN.',
        executable: 'Enter the full path of the program.', environmentVariables: 'Use variable names like MY_TOKEN.' } as Record<string, string>)[field] ?? 'Check the fields and try again.')
      return
    }
    setError(undefined)
    onReview(candidate.data)
  }
  useUnsavedChanges({ scope: 'surface', label: 'new MCP connection',
    dirty: Boolean(name || url || variable || executable || argumentsText || environment || transport !== 'remote'),
    busy, saveDisabled: true, error: 'Review the server before leaving, or discard it.',
    save: review, discard: () => {
      setName(''); setUrl(''); setVariable(''); setExecutable(''); setArgumentsText(''); setEnvironment(''); setTransport('remote'); setError(undefined)
    },
  })
  return <div className="harness-form-stack">
    <TextField label="Server name" value={name} maxLength={80} autoComplete="off" onChange={(event) => setName(event.target.value)} />
    <Select label="Connection" value={transport} options={[{ value: 'remote', label: 'Remote URL' }, { value: 'stdio', label: 'Local program' }]}
      onChange={(event) => setTransport(event.target.value as typeof transport)} />
    {transport === 'remote' ? <>
      <TextField label="Server URL" type="url" placeholder="https://example.com/mcp" value={url} onChange={(event) => setUrl(event.target.value)} />
      <TextField label="Token variable (optional)" placeholder="MY_SERVICE_TOKEN" autoComplete="off" spellCheck={false} value={variable}
        labelHint={<InfoHint label="Token variable">The name of an environment variable that holds the token, not the token itself.</InfoHint>} onChange={(event) => setVariable(event.target.value)} />
    </> : <>
      <TextField label="Program path" value={executable} placeholder="/absolute/path/to/mcp-server" autoComplete="off" onChange={(event) => setExecutable(event.target.value)} />
      <Textarea label="Arguments (one per line)" rows={3} value={argumentsText} spellCheck={false} onChange={(event) => setArgumentsText(event.target.value)} />
      <TextField label="Environment variables (optional)" value={environment} autoComplete="off" placeholder="SERVICE_TOKEN, SERVICE_ACCOUNT" onChange={(event) => setEnvironment(event.target.value)} />
    </>}
    {error ? <Alert tone="danger" live title={error} /> : null}
    <div className="harness-step-actions"><Button variant="primary" disabled={busy || disabled} loading={busy} onClick={review}>Review</Button></div>
  </div>
}

type NativeMcpManagerProps = { harness: Harness; accessUnavailable?: boolean }

function useNativeMcpManager({ harness, accessUnavailable = false }: NativeMcpManagerProps) {
  const guard = useContext(UnsavedChangesContext)
  const servers = useNativeMcpServers(harness, !accessUnavailable)
  const accessError = useProtectedAccessError(servers)
  const blocked = accessUnavailable || Boolean(accessError)
  const serverData = blocked ? undefined : servers.data
  const plans = useNativeMcpPlans(harness, !blocked)
  const request = useRequestNativeMcpChange()
  const decision = useDecideNativeMcpChange()
  const managed = useApplyManagedMcpChange(harness, plans.data?.items)
  const reconciliation = useReconcileNativeMcpChange()
  const reconciliationAttempts = useRef(new Map<string, CommandAttempt<Omit<HarnessMcpReconcileInput, 'commandId'>>>())
  const [reconcileInputs, setReconcileInputs] = useState<Record<string, HarnessMcpReconcileInput>>({})
  const [observedAcceptance, setObservedAcceptance] = useState<Record<string, boolean>>({})
  const [adding, setAdding] = useState(false)
  const [active, setActive] = useState<string>()
  const [detailsName, setDetailsName] = useState<string>()
  const [created, setCreated] = useState<HarnessMcpPlan>()
  const [feedback, setFeedback] = useState<string>()
  // A failed HTTP response may hide a committed plan. Reuse the same receipt ID on retry.
  const command = useRef<{ signature: string; id: string } | undefined>(undefined)
  const allPlans = blocked ? [] : [...(plans.data?.items ?? [])]
  const managedPlan = managed.operation?.plan
  const selected = blocked ? undefined : allPlans.find((plan) => plan.id === active)
    ?? (decision.data?.id === active ? decision.data : undefined)
    ?? (created?.id === active ? created : managedPlan?.id === active ? managedPlan : undefined)
  const reconcileInput = selected ? reconcileInputs[selected.id] : undefined
  const acceptObservedState = selected ? observedAcceptance[selected.id] ?? false : false
  const inspection = useNativeMcpServers(selected?.harness ?? harness, Boolean(active) && !blocked)
  const expired = Boolean(selected && Date.parse(selected.expiresAt) <= Date.now())
  const requestChange = (change: HarnessMcpChange) => {
    if (!serverData || servers.isError || request.isPending) return
    const signature = JSON.stringify([harness, serverData.revision, change])
    if (command.current?.signature !== signature) command.current = { signature, id: crypto.randomUUID() }
    setFeedback(undefined)
    decision.reset()
    request.mutate({ harness, commandId: command.current.id, expectedRevision: serverData.revision, change }, {
      onSuccess: (result) => { setCreated(result.value); setActive(result.value.id); setAdding(false) },
    })
  }
  const decide = (approve: boolean) => {
    if (!selected || selected.status !== 'pending') return
    decision.mutate({ planId: selected.id, approve }, { onSuccess: (result) => {
      setCreated(result)
      if (result.status === 'applied') { setFeedback('Connection settings saved.'); setActive(undefined) }
      if (result.status === 'rejected') setActive(undefined)
    } })
  }
  const manage = (preset: HarnessMcpManagedPreset, change: { installed: boolean } | { enabled: boolean }) => {
    if (!serverData || servers.isError || managed.isPending || managed.operation) return
    setFeedback(undefined)
    managed.start({ preset, ...change, expectedRevision: serverData.revision })
  }
  const reconcile = () => {
    if (!selected || !inspection.data || reconciliation.isPending) return
    const attempt = reconciliationAttempts.current.get(selected.id) ?? new CommandAttempt<Omit<HarnessMcpReconcileInput, 'commandId'>>()
    reconciliationAttempts.current.set(selected.id, attempt)
    const clearInput = () => setReconcileInputs((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== selected.id)))
    const input = reconcileInput ?? attempt.input({
      planId: selected.id, expectedRevision: inspection.data.revision, acceptObservedState })
    if (input.planId !== selected.id) return
    setReconcileInputs((current) => ({ ...current, [selected.id]: input }))
    reconciliation.mutate(input, { onSuccess: (result) => {
      attempt.succeeded(); clearInput()
      setObservedAcceptance((current) => ({ ...current, [selected.id]: false }))
      setCreated(result.value); setActive(undefined)
      setFeedback(result.value.status === 'applied' ? 'The intended settings were confirmed. No native write was repeated.'
        : 'The current settings were recorded. The original write will not be repeated.')
    }, onError: (error) => {
      attempt.failed(error)
      if (!attempt.unresolved) clearInput()
    } })
  }
  const presets = serverData?.presets
  const details = serverData?.servers.find((server) => server.name === detailsName)
  const detailsPreset: HarnessMcpManagedPreset | undefined = details && APP_MCP_SERVER_NAMES.some((name) => name === details.name) && ['installed', 'disabled'].includes(presets?.[INSTALLATION_NAMES.mcp.server] ?? '') ? INSTALLATION_NAMES.mcp.server
    : details?.name === 'linear' && ['installed', 'disabled'].includes(presets?.linear ?? '') ? 'linear' : undefined
  const detailsRemovable = Boolean(details && (detailsPreset || details.editable))
  const outstanding = allPlans.filter((plan) => ['submitting', 'uncertain'].includes(plan.status)
    || (plan.harness === harness && plan.status === 'pending'))
  const managedBusy = managed.isPending || Boolean(managed.operation)
    || outstanding.some((plan) => plan.status === 'submitting' || plan.status === 'uncertain')
  const detailsBusy = managedBusy || request.isPending || decision.isPending || servers.isFetching || servers.isError
  useEffect(() => {
    if (managed.data?.status === 'applied' && managed.data.change.kind === 'remove' && managed.data.change.name === detailsName) setDetailsName(undefined)
    if (managed.operation && managed.operation.phase !== 'sending' && detailsName) setDetailsName(undefined)
  }, [managed.data, managed.operation, detailsName])
  return {
    guard, servers, blocked, serverData, plans, request, decision, managed, reconciliation,
    setObservedAcceptance, adding, setAdding, active, setActive, detailsName, setDetailsName, feedback,
    selected, reconcileInput, acceptObservedState, inspection, expired, requestChange, decide, manage,
    reconcile, presets, details, detailsPreset, detailsRemovable, outstanding, managedBusy, detailsBusy,
  }
}

function NativeMcpManager({ harness, accessUnavailable = false }: NativeMcpManagerProps) {
  const {
    guard, servers, blocked, serverData, plans, request, decision, managed, reconciliation,
    setObservedAcceptance, adding, setAdding, active, setActive, detailsName, setDetailsName, feedback,
    selected, reconcileInput, acceptObservedState, inspection, expired, requestChange, decide, manage,
    reconcile, presets, details, detailsPreset, detailsRemovable, outstanding, managedBusy, detailsBusy,
  } = useNativeMcpManager({
    harness, accessUnavailable,
  })
  const view = adding ? 'add' : active ? 'review' : detailsName ? 'details' : 'list'
  const back = (label: string, onBack: () => void, disabled = false) => <div className="harness-step-heading">
    <Button size="sm" variant="ghost" disabled={disabled} onClick={onBack}>Back</Button>
    <h4>{label}</h4></div>
  const status = (name: string, enabled: boolean, origin?: string) => !enabled ? 'Disabled'
    : origin === 'inherited' ? 'Inherited' : needsAttention(name, presets) ? 'Needs attention' : 'Enabled'
  return <section className="harness-mcp-manager" aria-label={`${harness} MCP connections`}>
    {view === 'add' ? <>
      {back('Add server', () => void (async () => { if (!guard || await guard.surfaces()) setAdding(false) })(), request.isPending)}
      <ConnectionForm busy={request.isPending} disabled={blocked || servers.isError} onReview={requestChange} />
      {request.isError ? <Alert tone="danger" live title={request.error.message} /> : null}
    </> : view === 'review' ? <>
      {back('Review change', () => setActive(undefined), decision.isPending || reconciliation.isPending)}
      {selected ? <div className="harness-form-stack"><ChangeDetails change={selected.change} />
        <p className="harness-access-warning">A server can run programs or send data to its endpoint. Only approve servers you trust.</p>
        {selected.status !== 'pending' || expired ? <Alert tone={selected.status === 'applied' ? 'success' : 'warning'} title={expired && selected.status === 'pending' ? 'This request expired. Reject it and add the server again.' : `Change ${selected.status}`}>
          {selected.error ?? (selected.status === 'uncertain' ? 'The change may already be saved. Confirm it below; it will not be written twice.' : null)}</Alert> : null}
        {['submitting', 'uncertain'].includes(selected.status) ? <>
          <Checkbox label="Keep the current settings even if the result can't be confirmed" checked={acceptObservedState}
            disabled={Boolean(reconcileInput) || reconciliation.isPending} onChange={(event) => setObservedAcceptance((current) => ({ ...current, [selected.id]: event.target.checked }))} />
          {inspection.isError ? <Alert tone="danger" title={inspection.error.message} /> : null}
          {reconciliation.isError ? <Alert tone="danger" live title={reconciliation.error.message} /> : null}
        </> : null}
        {decision.isError ? <Alert tone="danger" live title={decision.error.message} /> : null}
        <div className="harness-step-actions">{selected.status === 'pending' ? <><Button disabled={decision.isPending} onClick={() => decide(false)}>Reject</Button>
          <Button variant={selected.change.kind === 'remove' ? 'danger' : 'primary'} disabled={decision.isPending || expired} loading={decision.isPending} onClick={() => decide(true)}>Approve and apply</Button></>
          : ['submitting', 'uncertain'].includes(selected.status) ? <>
            <Button disabled={(inspection.isFetching && !inspection.isRefetching) || reconciliation.isPending} onClick={() => void inspection.refetch()}>Check again</Button>
            <Button variant="primary" disabled={!inspection.data || inspection.isError || inspection.isFetching || reconciliation.isPending} loading={reconciliation.isPending} onClick={reconcile}>Confirm change</Button>
          </> : null}</div>
      </div> : <p role="status" className="harness-muted">Loading request…</p>}
    </> : view === 'details' ? <>
      {back(details?.name ?? 'Server', () => setDetailsName(undefined), managed.isPending)}
      {details ? <div className="harness-form-stack">
        <dl className="harness-change-details">
          <div><dt>Status</dt><dd><StatusBadge tone={!details.enabled ? 'danger' : status(details.name, details.enabled, details.origin) === 'Enabled' ? 'success' : 'warning'}
            label={status(details.name, details.enabled, details.origin)} /></dd></div>
          <div><dt>Connection</dt><dd>{details.transport === 'remote' ? 'Remote' : details.transport === 'stdio' ? 'Local program' : 'Built in'}</dd></div>
          <div><dt>{details.transport === 'remote' ? 'Host' : 'Program'}</dt><dd>{details.endpoint ?? details.label}</dd></div>
          <div><dt>Source</dt><dd>{details.origin === 'inherited' ? 'Another config file' : details.protected ? 'Managed by Foreman Code' : 'Your Codex config'}</dd></div>
        </dl>
        {LEGACY_APP_SERVERS.includes(details.name) ? <p className="harness-muted">Retired. Use Upgrade to Foreman Code MCP to replace it.</p>
          : !detailsRemovable ? <p className="harness-muted">{details.protected ? 'Managed by Foreman Code.' : 'Change it in the config file it comes from.'}</p> : null}
        {details.name === 'linear' && detailsPreset === 'linear' ? <p className="harness-muted">Sign in with <code>codex mcp login linear</code>.</p> : null}
        <div className="harness-step-actions">
          {details.name === INSTALLATION_NAMES.mcp.server && detailsPreset === INSTALLATION_NAMES.mcp.server ? <Button disabled={detailsBusy} onClick={() => manage(INSTALLATION_NAMES.mcp.server, { installed: true })}>Rename to Foreman Code MCP</Button> : null}
          {detailsPreset || details.editable ? <Button disabled={detailsBusy} onClick={() => {
            if (detailsPreset) manage(detailsPreset, { enabled: !details.enabled })
            else { setDetailsName(undefined); requestChange({ kind: 'enable', name: details.name, enabled: !details.enabled }) }
          }}>{details.enabled ? 'Disable' : 'Enable'}</Button> : null}
          {detailsRemovable ? <Button variant="danger" leading={<Icon name="trash" size={16} />} disabled={detailsBusy} onClick={() => {
            if (detailsPreset) manage(detailsPreset, { installed: false })
            else { setDetailsName(undefined); requestChange({ kind: 'remove', name: details.name }) }
          }}>Remove</Button> : null}
        </div>
      </div> : <p role="status" className="harness-muted">This server is gone. Go back to see current servers.</p>}
    </> : <>
    <div className="harness-section-heading"><h4>MCP servers <InfoHint label="Connections">New sessions use them.</InfoHint></h4>
      <div className="harness-inline-actions"><Button size="sm" variant="ghost" disabled={servers.isFetching} loading={servers.isRefetching} onClick={() => void servers.refetch()}>Refresh</Button>
        <Button size="sm" variant="primary" disabled={!serverData || servers.isError} onClick={() => { request.reset(); setAdding(true) }}>Add server</Button></div></div>
    {blocked ? <Alert tone="warning" title="Connections are unavailable right now." /> : null}
    {servers.isPending && !blocked ? <ul className="harness-server-list" aria-busy="true" aria-label="Loading servers">{[0, 1].map((key) => <li key={key} className="harness-server-skeleton" />)}</ul> : null}
    {servers.isError && !blocked ? <Alert tone="danger" title="Couldn't read servers." action={<Button size="sm" onClick={() => void servers.refetch()}>Retry</Button>} /> : null}
    {request.isError ? <Alert live tone="danger" title={request.error.message} /> : null}
    {managed.operation ? <Alert live tone="warning" title={managed.operation.phase === 'sending' ? 'Applying change…' : 'Change needs attention'}>
      {managed.operation.error ?? (managed.operation.phase === 'sending' ? null : 'Review it before making another change.')}
      {managed.operation.phase === 'retry' ? <Button size="sm" disabled={blocked || servers.isError}
        onClick={managed.retry}>Retry</Button> : null}
      {managed.operation.plan ? <Button size="sm" disabled={blocked}
        onClick={() => { decision.reset(); setActive(managed.operation!.plan!.id) }}>Review</Button> : null}
    </Alert> : managed.isError ? <Alert live tone="danger" title="Change failed">{managed.error.message}</Alert> : null}
    {managed.data?.status === 'applied' || feedback ? <p role="status" className="harness-success">{feedback ?? 'Saved.'}</p> : null}
    {presets ? <div className="harness-preset-actions" aria-label="Suggested MCP servers">
      {([INSTALLATION_NAMES.mcp.server, 'linear'] as const).map((preset) => {
        const presetStatus = presets[preset]
        if (presetStatus === 'installed' || presetStatus === 'disabled') return null
        const label = preset === INSTALLATION_NAMES.mcp.server ? 'Foreman Code MCP' : 'Linear MCP'
        const actionable = presetStatus === 'missing' || presetStatus === 'legacy'
          || (presetStatus === 'mismatch' && (preset !== 'linear' || !serverData?.servers.find((server) => server.name === 'linear')?.protected))
        const description = presetStatus === 'missing' ? preset === INSTALLATION_NAMES.mcp.server ? 'App tools for Operator and workflow agents.' : 'Read-only Linear access.'
          : presetStatus === 'legacy' ? 'Replaces the two older app connections.'
            : presetStatus === 'inherited' ? 'Set in another config file.'
              : preset === INSTALLATION_NAMES.mcp.server ? 'Needs repair. Its tool settings are kept.' : 'Not the read-only setup.'
        return <div key={preset} className="harness-preset-row"><div><strong>{label}</strong><small>{description}</small></div>
          {actionable ? <Button size="sm" disabled={managedBusy || servers.isFetching || servers.isError} loading={managed.isPending && managed.variables?.preset === preset}
            onClick={() => manage(preset, { installed: true })}>{presetStatus === 'legacy' ? 'Upgrade' : presetStatus === 'mismatch' ? preset === 'linear' ? 'Make read-only' : 'Repair' : 'Add'}</Button>
            : <StatusBadge tone="warning" label={presetStatus === 'inherited' ? 'Inherited' : 'Needs attention'} />}
        </div>
      })}
    </div> : null}
    {serverData?.servers.length === 0 ? <p className="harness-muted">No servers yet.</p> : null}
    {serverData?.servers.length ? <ul className="harness-server-list">{serverData.servers.map((server) => {
      const label = status(server.name, server.enabled, server.origin)
      return <li key={server.name}>
        <button type="button" className="harness-server-open" aria-label={`View details for ${server.name}, ${label}`} onClick={() => setDetailsName(server.name)}>
          <span className="harness-server-symbol" aria-hidden="true">{server.transport === 'remote' ? '↗' : '⌘'}</span>
          <span className="harness-server-name"><strong>{server.name}</strong></span>
          <span className="harness-server-status" data-status={label === 'Enabled' ? 'enabled' : label === 'Disabled' ? 'disabled' : 'attention'} aria-hidden="true" />
        </button>
      </li>
    })}</ul> : null}
    {outstanding.length ? <section className="harness-pending-plans" aria-label="MCP change requests"><h4>Waiting for review</h4>
      {outstanding.map((plan) => {
        const operation = managed.operation
        const kind = operation && ('enabled' in operation.input ? 'enable' : operation.input.installed ? 'add' : 'remove')
        const applying = operation?.phase === 'sending' && plan.harness === harness && plan.managedPreset === operation.input.preset
          && plan.change.kind === kind
        return <div key={plan.id} className="harness-plan-row"><span>{words[plan.change.kind]} <strong>{plan.change.name}</strong> <small>{applying ? 'Applying…' : plan.status === 'pending' && Date.parse(plan.expiresAt) <= Date.now() ? 'Expired' : plan.status}</small></span>
          {applying ? null : <Button size="sm" onClick={() => { decision.reset(); setActive(plan.id) }}>Review</Button>}</div>
      })}
    </section> : null}
    {plans.isError ? <p className="harness-muted" role="status">Couldn't load pending changes.</p> : null}
    </>}
  </section>
}

export function HarnessMcpManager({ harness, accessUnavailable }: { harness: Harness; accessUnavailable?: boolean }) {
  const epoch = useHarnessSessionEpoch()
  return <NativeMcpManager key={`${harness}:${epoch}`} harness={harness} accessUnavailable={accessUnavailable} />
}
