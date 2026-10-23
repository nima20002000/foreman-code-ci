import { useEffect } from 'react'
import { Button, Select, Switch } from '../../shared/ui/nocturne'
import { NodeRow } from '../graph'
import type { BrowserComputerLabel, BrowserProfileCatalog } from '../browser-profiles'
import { DEFAULT_AGENT_BROWSER_TABS } from '@foreman-code/contracts/browser-profiles'
import type { NodeBrowserSettings } from './types'

const TAB_LIMITS = Array.from({ length: 10 }, (_, index) => ({ value: String(index + 1), label: String(index + 1) }))

export interface BrowserSettingsFieldsProps {
  value: NodeBrowserSettings | undefined
  onChange(value: NodeBrowserSettings): void
  catalog: BrowserProfileCatalog | undefined
  computer: BrowserComputerLabel | undefined
  disabled?: boolean
  loading?: boolean
  onManageProfiles(): void
}

/** The profile a newly enabled browser uses: one named "Default", else the first one (ready here first, then by name). */
function defaultProfileId(profiles: BrowserProfileCatalog['profiles']): string | undefined {
  return (profiles.find(profile => profile.name.trim().toLowerCase() === 'default') ?? profiles[0])?.id
}

/** A controlled draft field. Applying/saving belongs to the existing Board form. */
export function BrowserSettingsFields({ value, onChange, catalog, computer, disabled, loading, onManageProfiles }: BrowserSettingsFieldsProps) {
  const enabled = value?.enabled ?? false
  const maxTabs = value?.maxTabs
  const selected = catalog?.profiles.find(profile => profile.id === value?.profileId)
  const replica = catalog?.replicas.find(item => item.profileId === value?.profileId && item.computerId === computer?.id)
  const profiles = [...(catalog?.profiles ?? [])].sort((left, right) => {
    const available = (id: string) => catalog?.presentReplicas.some(item => item.profileId === id && item.computerId === computer?.id)
    return Number(available(right.id)) - Number(available(left.id)) || left.name.localeCompare(right.name)
  })
  const fallback = defaultProfileId(profiles)
  // A browser that is on always has a profile: pick the default once the profiles are known.
  useEffect(() => {
    if (enabled && !value?.profileId && fallback && !disabled) onChange({ enabled: true, profileId: fallback, ...(maxTabs ? { maxTabs } : {}) })
  }, [enabled, value?.profileId, maxTabs, fallback, disabled, onChange])
  const options = [...(value?.profileId ? [] : [{ value: '', label: loading ? 'Loading…' : 'No profile' }]),
    ...profiles.map(profile => ({ value: profile.id, label: profile.name }))]
  if (value?.profileId && !selected) options.push({ value: value.profileId, label: 'Removed profile' })
  const readiness = !computer ? undefined
    : !computer.online ? `${computer.name} is offline.` : !computer.runtimeReady ? `Browser setup needed on ${computer.name}.`
      : !catalog?.presentReplicas.some(item => item.profileId === value?.profileId && item.computerId === computer.id)
        ? `This profile isn’t on ${computer.name} yet.` : replica?.reason ?? undefined
  let note: string | undefined = readiness
  if (value?.profileId && !selected && catalog) note = 'This profile was removed. Choose another.'
  else if (enabled && !profiles.length && !loading) note = 'No browser profiles yet.'
  return <>
    <NodeRow label="Browser">
      <Switch label="Browser" checked={enabled} disabled={disabled}
        onChange={event => onChange(event.currentTarget.checked
          ? { ...value, enabled: true, ...(value?.profileId ?? fallback ? { profileId: value?.profileId ?? fallback } : {}) }
          : { ...value, enabled: false })} />
    </NodeRow>
    {enabled ? <NodeRow label="Profile" tone="warning" note={note && <>{note} {!profiles.length || value?.profileId && !selected
      ? <Button variant="ghost" size="sm" onClick={onManageProfiles}>Manage profiles</Button> : null}</>}>
      <Select label="Browser profile" value={value?.profileId ?? ''} options={options} disabled={disabled || loading}
        onChange={event => {
          const next: NodeBrowserSettings = { ...value, enabled: true, profileId: event.currentTarget.value }
          if (!next.profileId) delete next.profileId
          onChange(next)
        }} />
    </NodeRow> : null}
    {enabled ? <NodeRow label="Max tabs" note="The agent reuses its tabs and can’t open more than this.">
      <Select label="Most tabs open at once" value={String(value?.maxTabs ?? DEFAULT_AGENT_BROWSER_TABS)} options={TAB_LIMITS}
        disabled={disabled} onChange={event => onChange({ ...value, enabled: true, maxTabs: Number(event.currentTarget.value) })} />
    </NodeRow> : null}
  </>
}
