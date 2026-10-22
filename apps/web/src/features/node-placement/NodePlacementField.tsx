import { useState } from 'react'
import type { SavedNodePlacement } from '@foreman-code/contracts/node-placement'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { Select } from '../../shared/ui/nocturne'
import { NodeRow } from '../graph/AgentMainFields'

/** Presentation only. The caller supplies authorized, revision-pinned choices;
 * this control never discovers hosts, validates remote paths or creates pins. */
export type NodePlacementOption = Readonly<{
  placement: SavedNodePlacement
  label: string
  unavailableReason?: string
  commit?: string
}>
/** A paired computer that can't run this Agent; it stays in the list so choosing it explains why. */
export type UnavailableComputer = Readonly<{ name: string; reason: string }>
export type NodePlacementFieldProps = {
  value?: SavedNodePlacement
  options: readonly NodePlacementOption[]
  unavailableComputers?: readonly UnavailableComputer[] | undefined
  onChange(value: SavedNodePlacement | undefined): void
  disabled?: boolean | undefined
  optionsState?: 'ready' | 'loading' | 'unavailable' | undefined
  /** Why choices can't be read right now. */
  note?: string | undefined
  inheritedWorktree?: string | undefined
}

/** Choice labels read "<computer> · <harness> · <folder>"; show the computer, and the folder only to tell two apart. */
function optionLabels(options: readonly NodePlacementOption[]): string[] {
  const hosts = options.map(option => option.label.split(' · ')[0] ?? option.label)
  return options.map((option, index) => {
    const host = hosts[index]!
    const folder = option.placement.projectRoot.split('/').filter(Boolean).at(-1)
    return hosts.filter(item => item === host).length > 1 && folder ? `${host} · ${folder}` : host
  })
}

export function NodePlacementField({ value, options, unavailableComputers = [], onChange, disabled, optionsState = 'ready', note,
  inheritedWorktree }: NodePlacementFieldProps) {
  const [blocked, setBlocked] = useState<string>()
  const selected = value ? options.findIndex((option) => sameWorkflowValue(option.placement, value)) : -1
  const current = selected >= 0 ? options[selected] : undefined
  const labels = optionLabels(options)
  let selection = value ? selected < 0 ? 'retained' : String(selected) : 'inherited'
  if (blocked) selection = blocked
  const blockedReason = blocked?.startsWith('computer:') ? unavailableComputers[Number(blocked.slice(9))]?.reason
    : blocked ? options[Number(blocked)]?.unavailableReason : undefined
  let message: string | undefined = blockedReason
  if (!message && value && current?.unavailableReason) message = current.unavailableReason
  else if (!message && value && !current && optionsState === 'ready') message = 'The saved computer is no longer available. Choose another.'
  else if (!message && optionsState === 'loading') message = 'Checking computers…'
  else if (!message && optionsState === 'unavailable') message = note ?? 'Computers can’t be checked right now.'
  return <NodeRow label="Computer" note={message} tone={blockedReason || current?.unavailableReason ? 'warning' : undefined}>
    <Select label="Computer" aria-label="Computer" className="agent-node-inline" value={selection} disabled={disabled}
      options={[
        { value: 'inherited', label: inheritedWorktree ? 'Workflow default' : 'Main (default)' },
        ...(value && selected < 0 ? [{ value: 'retained', label: 'Saved computer', disabled: true }] : []),
        ...options.map((option, index) => ({ value: String(index),
          label: option.unavailableReason ? `${labels[index]} · unavailable` : labels[index]! })),
        ...unavailableComputers.map((computer, index) => ({ value: `computer:${index}`, label: `${computer.name} · unavailable` })),
      ]} onChange={(event) => {
        const choice = event.target.value
        if (choice === 'inherited') {
          setBlocked(undefined)
          onChange(undefined)
          return
        }
        const option = choice.startsWith('computer:') ? undefined : options[Number(choice)]
        if (!option || option.unavailableReason) {
          // An unavailable computer is shown with its reason and never replaces the working choice.
          setBlocked(choice)
          return
        }
        setBlocked(undefined)
        onChange(structuredClone(option.placement))
      }} />
  </NodeRow>
}
