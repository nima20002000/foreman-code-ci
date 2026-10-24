import { INSTALLATION_NAMES } from '@foreman-code/contracts/installation-names'
import { useState } from 'react'
import { agentTemplateForRole, nativeToolsSummary, memoryBoardTools, newAgentForemanTools, type AgentDefaults } from '@foreman-code/contracts'
import type { SettingsAgentRole } from '@foreman-code/contracts/management'
import { ErrorState, LoadingState, Switch } from '../../shared/ui/nocturne'
import { useAgentDefaultsQuery, useUpdateAgentDefaultsMutation } from '../../shared/api/query'
import { SettingsChoice, SettingsOverview } from './SettingsCards'
import { agentRoleOrder, harnessSummary, rolePresentation } from './settingsPresentation'
import { AgentRoleSettings } from './AgentRoleSettings'
import { PromptSettings } from './PromptSettings'

/** Hiding the chat would also hide the way to ask for it back, so this one setting stays a direct switch. */
function OperatorChatVisibility({ value, revision }: { value: AgentDefaults; revision: number }) {
  const save = useUpdateAgentDefaultsMutation()
  const [commandId, setCommandId] = useState(() => crypto.randomUUID())
  return <>
    <Switch label="Show Operator chat" checked={value.operator.uiEnabled} disabled={save.isPending}
      onChange={(event) => save.mutate({ commandId, expectedRevision: revision,
        value: { ...value, operator: { ...value.operator, uiEnabled: event.target.checked } } },
      { onSuccess: () => setCommandId(crypto.randomUUID()) })} />
    {save.isError ? <small className="operator-mcp-error" role="alert">{save.error.message}</small> : null}
  </>
}

/** Role defaults are summary cards; each opens its own editor. */
export function AgentDefaultsSettings({ selectedRole, promptOpen = false, onOpen }: {
  selectedRole?: SettingsAgentRole; promptOpen?: boolean; onOpen?(role?: SettingsAgentRole, section?: 'prompt'): void;
}) {
  const query = useAgentDefaultsQuery()
  if (selectedRole === 'operator' && promptOpen) return <PromptSettings page="operator-initial-prompt" />
  if (selectedRole) return <AgentRoleSettings key={selectedRole} role={selectedRole}
    onEditPrompt={() => onOpen?.('operator', 'prompt')} />
  if (query.isError) return <ErrorState title="Agent defaults are unavailable" description={query.error.message} onRetry={() => void query.refetch()} />
  if (!query.data) return <LoadingState label="Loading agent defaults…" />
  const { value, revision } = query.data
  return <SettingsOverview title="Agents">
    {agentRoleOrder.map((role) => {
      const info = rolePresentation[role]
      const template = role === 'operator' ? value.operator : agentTemplateForRole(value, role)
      const tools = role === 'operator' ? [] : template[INSTALLATION_NAMES.fields.agentTools] ?? newAgentForemanTools(role)
      const memory = memoryBoardTools('write').filter(tool => tools.includes(tool))
      const memoryLabel = memory.length ? 'Write' : 'None'
      const summary = [...harnessSummary(template.harness),
        { label: 'Tools', value: nativeToolsSummary(template.nativeTools) }, ...(role === 'operator' ? [] : [{ label: 'Memory', value: memoryLabel }]), ...(role === 'master' && !value.master
          ? [{ label: 'Settings', value: 'Same as Orchestrator' }] : []), ...(role === 'operator' ? [
        { label: 'Skills', value: String(value.operator.assignedSkills?.length ?? 0) },
        ...(value.operator.harness.harness === 'codex' ? [{ label: 'Thinking', value: value.operator.showThinking ? 'Shown' : 'Hidden' }] : []),
      ] : [])]
      return <SettingsChoice key={role} title={info.title} summary={summary}
        onSelect={() => onOpen?.(role)}
        footer={role === 'operator' ? <OperatorChatVisibility value={value} revision={revision} /> : undefined} />
    })}
  </SettingsOverview>
}
