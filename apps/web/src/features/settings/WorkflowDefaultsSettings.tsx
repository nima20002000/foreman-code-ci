import { WorkflowDefaultsSchema, type WorkflowDefaults } from '@foreman-code/contracts'

import { useUpdateWorkflowDefaultsMutation, useWorkflowDefaultsQuery } from '../../shared/api/query'
import { Button, Select, SettingRow, SettingsSection, Skeleton } from '../../shared/ui/nocturne'
import { fieldMessage } from './fieldValidation'
import { SettingsFormActions, SettingsFormFeedback } from './SettingsFormActions'
import { useSettingsValidation } from './useSettingsValidation'
import { useRevisionedForm } from './revisionedForm'
import './settingsExperience.css'

const approvalOptions = [
  { value: 'user', label: 'You' },
  { value: 'orchestrator', label: 'A coordinator agent' },
  { value: 'native', label: 'The harness (Codex or Claude)' },
] as const

/** Workflow defaults: one section, one row; loading keeps the row's shape. */
export function WorkflowDefaultsSettings() {
  const query = useWorkflowDefaultsQuery()
  const mutation = useUpdateWorkflowDefaultsMutation()
  const form = useRevisionedForm<WorkflowDefaults>(query.data
    ? { value: query.data.value, revision: query.data.revision } : undefined, 'settings:workflows')
  const root = useSettingsValidation(form.issues)
  const handlerError = fieldMessage(form.issues ?? [], 'approvalHandler')
  const draft = form.draft
  return <section ref={(node) => { root.current = node }} className="settings-editor-page" aria-label="Workflow defaults">
    <header className="settings-experience-heading"><h1>Workflows</h1></header>
    <SettingsFormFeedback form={form} />
    <SettingsSection title="Approvals" description="Used by new workflows. Each workflow can change it.">
      <SettingRow title="Who approves" description="Answers when an agent asks before a sensitive action.">
        {draft ? <Select label="Approval handler" className="settings-inline-field" value={draft.approvalHandler} error={handlerError} options={approvalOptions}
          onChange={(event) => form.setDraft({ approvalHandler: event.target.value as WorkflowDefaults['approvalHandler'] })} />
          : query.isError ? <p className="settings-note">Couldn&rsquo;t load. <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>Retry</Button></p>
            : <Skeleton width="14rem" height="2.5rem" />}
      </SettingRow>
      {draft && query.isError ? <p className="settings-note" role="alert">Couldn&rsquo;t refresh. Your edits are kept.
        <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>Retry</Button></p> : null}
    </SettingsSection>
    {draft ? <SettingsFormActions form={form} saveLabel="Save workflow defaults" onSave={() => form.save(async (input) => {
      const response = await mutation.mutateAsync(input)
      return { value: response.value.value, revision: response.value.revision }
    }, (value) => WorkflowDefaultsSchema.parse(value))} /> : null}
  </section>
}
