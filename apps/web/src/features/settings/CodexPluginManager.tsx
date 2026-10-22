import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { Alert, Button, Icon, LoadingState, StatusBadge, TextField } from '../../shared/ui/nocturne'
import { useChangeCodexPlugin, useCodexPlugin, useCodexPlugins } from '../../shared/api/harnessSettings'
import { useAccessFailureLatch } from '../../shared/api/useAccessFailureLatch'
import './codexPlugins.css'

export function CodexPluginManager({ accessUnavailable = false }: { accessUnavailable?: boolean }) {
  const search = useSearch({ from: '/settings/harnesses' })
  const navigate = useNavigate({ from: '/settings/harnesses' })
  const view = search.pluginView ?? 'installed'
  const query = search.pluginQuery ?? ''
  const offset = search.pluginOffset ?? 0
  const selectedId = search.pluginId
  // The URL remains authoritative; only request admission is debounced.
  const [settledQuery, setSettledQuery] = useState(query)
  useEffect(() => {
    const timer = setTimeout(() => setSettledQuery(query), 300)
    return () => clearTimeout(timer)
  }, [query])
  const list = useCodexPlugins({ view, query, offset, limit: 24 }, settledQuery === query && !accessUnavailable)
  const detail = useCodexPlugin(accessUnavailable ? undefined : selectedId)
  const change = useChangeCodexPlugin()
  const listDenied = useAccessFailureLatch(list)
  const detailDenied = useAccessFailureLatch(detail)
  const denied = accessUnavailable || listDenied || detailDenied
  const catalog = denied ? undefined : list.data
  const reviewed = denied ? undefined : detail.data
  const plugin = reviewed?.plugin
  const lastTrigger = useRef<HTMLButtonElement>(null)
  const lastPluginId = useRef<string | undefined>(undefined)
  const wasOpen = useRef(false)
  const searchField = useRef<HTMLInputElement>(null)
  const handledResult = useRef<unknown>(undefined)
  const [feedback, setFeedback] = useState<string>()
  const move = useCallback((fields: Partial<typeof search>) => void navigate({ search: { ...search, ...fields }, replace: true }), [navigate, search])
  useEffect(() => {
    if (catalog && offset > 0 && offset >= catalog.total) move({ pluginOffset: Math.max(0, Math.floor((catalog.total - 1) / 24) * 24) })
  }, [catalog, offset, move])
  useEffect(() => {
    if (selectedId) { wasOpen.current = true; return }
    if (!wasOpen.current || !lastPluginId.current) return
    wasOpen.current = false
    const card = lastTrigger.current?.isConnected ? lastTrigger.current
      : [...document.querySelectorAll<HTMLButtonElement>('.codex-plugin-card')].find((item) => item.dataset.pluginId === lastPluginId.current)
    ;(card ?? searchField.current)?.focus()
  }, [selectedId])
  useEffect(() => {
    const result = change.reconciliation.submittedAt > change.submittedAt ? change.reconciliation.data : change.data
    if (!result || result.status === 'uncertain' || handledResult.current === result) return
    handledResult.current = result
    setFeedback(result.message)
    if (result.status !== 'applied') return
    if (result.action === 'remove') move({ pluginId: undefined })
    else move({ pluginView: 'installed', pluginQuery: undefined, pluginOffset: 0 })
  }, [change.data, change.submittedAt, change.reconciliation.data, change.reconciliation.submittedAt, move])
  const refresh = async () => {
    if (accessUnavailable) return
    // A successful list read is not a receipt or native process reconciliation.
    await Promise.allSettled([list.refresh(), change.operations.refetch()])
    if (selectedId) await detail.refetch()
  }
  const snapshotReady = Boolean(reviewed && catalog && list.isSuccess && detail.isSuccess
    && !list.isFetching && !detail.isFetching && settledQuery === query
    && reviewed.plugin.pluginId === selectedId && reviewed.revision === catalog.revision)
  const busy = change.busy || Boolean(change.operation) || !change.operations.isSuccess || change.operations.isFetching
  const act = (action: 'install' | 'remove') => {
    if (!snapshotReady || !reviewed || busy || reviewed.plugin.unavailableReason || reviewed.plugin.verification === 'unverified') return
    if (action === 'install' && catalog?.catalogStatus !== 'complete') return
    setFeedback(undefined)
    change.start({ pluginId: reviewed.plugin.pluginId, action, expectedRevision: reviewed.revision, artifactIdentity: reviewed.artifactIdentity })
  }
  const pending = change.operation
  const rejection = !denied && change.isError && !pending ? <Alert tone="danger" live title="Plugin change failed"
    action={<Button size="sm" disabled={list.isFetching || detail.isFetching}
      onClick={() => void refresh()}>Refresh</Button>}>{change.error.message}</Alert> : null
  const recovery = !denied && pending ? <Alert tone="warning" live title={pending.phase === 'sending' ? 'Checking the last change…' : 'The last change may not have finished'}>
    {pending.phase !== 'sending' ? <>
      <p>{pending.result?.message ?? pending.error ?? 'It may already be done. Check it before changing anything else.'}</p>
      {!pending.requestedBy && pending.input && pending.phase === 'retry'
        ? <Button size="sm" disabled={change.busy} onClick={change.retry}>Retry</Button> : null}
      <Button size="sm" disabled={change.busy} onClick={() => change.reconcile()}>Check it</Button>
      {pending.result?.observedRevision ? <Button size="sm" disabled={change.busy || list.isFetching || catalog?.revision !== pending.result.observedRevision} onClick={() => change.reconcile(true)}>Keep as is</Button> : null}
    </> : null}
  </Alert> : null
  const label = (item: NonNullable<typeof plugin>) => item.verification === 'unverified' ? 'Needs verification'
    : item.installed ? item.enabled ? 'Installed' : 'Disabled' : item.unavailableReason ? 'Unavailable' : 'Available'
  if (selectedId) return <section className="codex-plugins" aria-label="Codex plugins">
    <div className="harness-step-heading">
      <Button size="sm" variant="ghost" disabled={change.busy} onClick={() => move({ pluginId: undefined })}>Back</Button>
      <h4>{plugin?.name ?? 'Plugin'}</h4>
      {plugin ? <StatusBadge tone={plugin.verification === 'unverified' ? 'warning' : plugin.installed ? plugin.enabled ? 'success' : 'warning' : 'neutral'} label={label(plugin)} /> : null}
    </div>
    {!denied && detail.isPending ? <LoadingState label="Loading plugin…" rows={2} /> : null}
    {detail.isError && !denied ? <Alert tone="danger" title="Couldn't load this plugin."
      action={<Button size="sm" onClick={() => void detail.refetch()}>Retry</Button>} /> : null}
    {denied ? <Alert tone="danger" live title="Plugins are unavailable right now." /> : null}
    {recovery}
    {rejection}
    {feedback && !denied ? <p role="status" className="harness-success">{feedback}</p> : null}
    {plugin ? <div className="codex-plugin-detail">
      <dl className="harness-change-details">
        <div><dt>Marketplace</dt><dd>{plugin.marketplaceName}</dd></div>
        <div><dt>Version</dt><dd>{plugin.version ?? 'Unknown'}</dd></div>
        <div><dt>Sign-in</dt><dd>{plugin.authPolicy === 'ON_INSTALL' ? 'May be needed to install' : 'May be needed when used'}</dd></div>
        {reviewed?.contents.status === 'known' ? <>
          <div><dt>Skills</dt><dd>{reviewed.contents.skills.join(', ') || 'None'}</dd></div>
          <div><dt>MCP servers</dt><dd>{reviewed.contents.mcpServers.join(', ') || 'None'}</dd></div>
          <div><dt>Apps</dt><dd>{reviewed.contents.apps.join(', ') || 'None'}</dd></div>
          <div><dt>Hooks</dt><dd>{reviewed.contents.hooks.join(', ') || 'None'}</dd></div>
        </> : <div><dt>Contents</dt><dd>{plugin.installed ? 'Couldn\u2019t be read' : 'Shown after install'}</dd></div>}
      </dl>
      {plugin.unavailableReason ? <Alert tone="warning" title={plugin.unavailableReason} /> : null}
      {!plugin.installed && catalog?.catalogStatus === 'partial' ? <p className="harness-muted">Some sources didn't load. Refresh before installing.</p> : null}
      {plugin.installed && plugin.installPolicy === 'INSTALLED_BY_DEFAULT' ? <p className="harness-muted">Built into Codex; it can't be removed.</p> : null}
      <div className="harness-step-actions">
        <Button variant="ghost" disabled={accessUnavailable || list.isFetching || detail.isFetching || change.busy}
          loading={list.isFetching || detail.isFetching} onClick={() => void refresh()}>Refresh</Button>
        {!plugin.installed && plugin.installPolicy === 'AVAILABLE' ? <Button variant="primary" disabled={busy || !snapshotReady || Boolean(plugin.unavailableReason) || catalog?.catalogStatus !== 'complete'}
          loading={change.busy} onClick={() => act('install')}>Install</Button> : null}
        {plugin.installed && plugin.verification !== 'unverified' && plugin.installPolicy !== 'INSTALLED_BY_DEFAULT' ? <Button variant="danger" leading={<Icon name="trash" size={16} />}
          disabled={busy || !snapshotReady || Boolean(plugin.unavailableReason)} loading={change.busy} onClick={() => act('remove')}>Remove</Button> : null}
      </div>
    </div> : null}
  </section>
  return <section className="codex-plugins" aria-label="Codex plugins">
    <div className="codex-plugins-controls">
      <div className="codex-plugins-tabs" role="group" aria-label="Plugin catalog view">
        <Button size="sm" variant={view === 'installed' ? 'primary' : 'ghost'} aria-pressed={view === 'installed'} onClick={() => move({ pluginView: 'installed', pluginOffset: 0 })}>Installed</Button>
        <Button size="sm" variant={view === 'available' ? 'primary' : 'ghost'} aria-pressed={view === 'available'} onClick={() => move({ pluginView: 'available', pluginOffset: 0 })}>Discover</Button>
      </div>
      <Button size="sm" variant="ghost" disabled={accessUnavailable || list.isFetching || detail.isFetching || change.busy} loading={list.isRefetching} onClick={() => void refresh()}>Refresh</Button>
    </div>
    <TextField ref={searchField} label="Search plugins" type="search" maxLength={100} value={query} placeholder="Name or marketplace" onChange={(event) => move({ pluginQuery: event.target.value || undefined, pluginOffset: 0 })} />
    {recovery}
    {rejection}
    {!denied && change.operations.isError ? <Alert tone="warning" title="Couldn't check earlier changes. Refresh before changing plugins." /> : null}
    {feedback && !denied ? <p role="status" className="harness-success">{feedback}</p> : null}
    {list.isPending && !denied ? <LoadingState label="Loading plugins…" rows={2} /> : null}
    {list.isError && !denied ? <Alert tone="danger" title="Couldn't load plugins."
      action={<Button size="sm" onClick={() => void list.refetch()}>Retry</Button>} /> : null}
    {denied ? <Alert tone="danger" title="Plugins are unavailable right now." /> : null}
    {catalog ? <>
      {catalog.catalogStatus === 'partial' ? <p className="harness-muted">Some sources didn't load, so this list may be incomplete.</p> : null}
      {catalog.items.length ? <ul className={`codex-plugin-grid${view === 'available' ? ' codex-plugin-grid--available' : ''}`}>{catalog.items.map((item) => <li key={item.pluginId}>
        <button type="button" className={`codex-plugin-card${view === 'available' ? ' codex-plugin-card--available' : ''}`} data-plugin-id={item.pluginId} aria-label={`View ${item.name} plugin, ${label(item).toLowerCase()}`}
          onClick={(event) => { lastTrigger.current = event.currentTarget; lastPluginId.current = item.pluginId; move({ pluginId: item.pluginId }) }}>
          <span className="codex-plugin-identity"><strong>{item.name}</strong>{view === 'installed' ? <small>{item.marketplaceName}</small> : null}</span>
          {view === 'installed' ? <span className="codex-plugin-state">{label(item)}</span> : null}
        </button>
      </li>)}</ul> : <p className="harness-muted">{query ? 'No plugins match.' : view === 'installed' ? 'No plugins installed.' : 'No plugins found.'}</p>}
      {catalog.total > 24 ? <div className="codex-plugins-pages">
        <Button size="sm" variant="ghost" disabled={offset === 0 || list.isFetching} onClick={() => move({ pluginOffset: Math.max(0, offset - 24) })}>Previous</Button>
        <span className="harness-muted">{`${offset + 1}–${Math.min(offset + 24, catalog.total)} of ${catalog.total}`}</span>
        <Button size="sm" variant="ghost" disabled={catalog.nextOffset === null || list.isFetching} onClick={() => move({ pluginOffset: catalog.nextOffset ?? offset })}>Next</Button>
      </div> : null}
    </> : null}
  </section>
}
