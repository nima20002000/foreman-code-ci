import { useState } from 'react'
import type { WorkflowExecutionPolicy } from '@foreman-code/contracts'
import { MAX_AGENT_ACTIVE_TIMEOUT_MS } from '@foreman-code/contracts/current'
import { TextField } from '../../../shared/ui/nocturne'
import { InfoHint } from '../../../shared/ui'

/** Shows the server default as the value until the workflow sets its own; clearing the field goes back to the default. */
export function AgentActiveTimeField({ policy, defaultMs, onChange }: {
  policy: WorkflowExecutionPolicy
  defaultMs: number | undefined
  onChange(policy: WorkflowExecutionPolicy): void
}) {
  // While typing, an emptied field stays empty instead of snapping back to the default.
  const [typing, setTyping] = useState<string | null>(null)
  const hint = defaultMs === undefined
    ? 'Seconds per agent turn. Clear it to use the default.'
    : `Seconds per agent turn. Clear it to use the default (${defaultMs / 1000} s).`
  const saved = policy.agentActiveTimeoutMs
  const shown = saved !== undefined && Number.isFinite(saved) ? saved / 1000 : defaultMs === undefined ? '' : defaultMs / 1000
  return <TextField data-save-field="active-time" label="Turn time limit (s)"
    labelHint={<InfoHint label="Turn time limit">{hint}</InfoHint>}
    type="number" min={0.001} max={MAX_AGENT_ACTIVE_TIMEOUT_MS / 1000} step={0.001}
    placeholder={defaultMs === undefined ? 'Default' : `${defaultMs / 1000}`}
    value={typing ?? shown}
    onBlur={() => setTyping(null)}
    onChange={(event) => {
      setTyping(event.target.value)
      const next = { ...policy }
      if (event.target.value === '') delete next.agentActiveTimeoutMs
      else next.agentActiveTimeoutMs = Math.round(event.target.valueAsNumber * 1000)
      onChange(next)
    }} />
}
