import { WorkspaceFolderPicker } from './WorkspaceFolderPicker'
import { ProtectedAccessError } from '../../shared/ui/ProtectedAccessError'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import { WorkspaceDefaultsSchema, type WorkspaceDefaults } from '@foreman-code/contracts/management'
import { Button, SettingRow, SettingsSection, Skeleton, TextField, Textarea } from '../../shared/ui/nocturne'
import { useWorkspaceDefaultsQuery, useUpdateWorkspaceDefaultsMutation } from '../../shared/api/settingsExperience'
import { SettingsFormActions, SettingsFormFeedback } from './SettingsFormActions'
import { fieldMessage } from './fieldValidation'
import { useRevisionedForm } from './revisionedForm'
import { useSettingsValidation } from './useSettingsValidation'
import './settingsExperience.css'

/** Starting values for new workspaces: one section of label + control rows; loading keeps the rows' shape. */
export function WorkspaceDefaultsSettings() {
  const query = useWorkspaceDefaultsQuery()
  const mutation = useUpdateWorkspaceDefaultsMutation()
  const form = useRevisionedForm<WorkspaceDefaults>(query.data ? { value: query.data.value, revision: query.data.revision } : undefined, 'settings:workspaces')
  const root = useSettingsValidation(form.issues)
  const accessError = useProtectedAccessError(query, mutation.error)
  const draft = form.draft
  const issues = form.issues ?? []
  const placeholder = (height = '2.5rem') => query.isError
    ? <p className="settings-note">Couldn&rsquo;t load. <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>Retry</Button></p>
    : <Skeleton width="100%" height={height} />
  return <section ref={root} className="settings-editor-page" aria-label="Workspace defaults">
    <header className="settings-experience-heading"><h1>Workspaces</h1></header>
    {accessError ? <ProtectedAccessError error={accessError} /> : <>
      <SettingsFormFeedback form={form} />
      <SettingsSection title="New workspaces" description="Starting values when you create a workspace.">
        <SettingRow title="Name" description="Suggested name for a new workspace.">
          {draft ? <TextField label="Suggested workspace name" className="settings-inline-field settings-wide-field" maxLength={200} value={draft.suggestedName}
            error={fieldMessage(issues, 'suggestedName')} onChange={(event) => form.setDraft({ ...draft, suggestedName: event.target.value })} /> : placeholder()}
        </SettingRow>
        <SettingRow title="Description" description="Optional context agents see in every new workspace.">
          {draft ? <Textarea label="Starting description" className="settings-inline-field settings-wide-field" rows={3} maxLength={10_000} value={draft.description}
            error={fieldMessage(issues, 'description')} placeholder="Optional"
            onChange={(event) => form.setDraft({ ...draft, description: event.target.value })} /> : placeholder('5rem')}
        </SettingRow>
        <SettingRow title="Location" description="Folder new workspaces are created in.">
          {draft ? <div className="settings-wide-field">
            <WorkspaceFolderPicker value={draft.parentPath ?? ''} label="Default location" presentation="compact"
              disabled={form.isSaving || form.uncertain} onSelect={(parentPath) => form.setDraft({ ...draft, parentPath })} />
            {fieldMessage(issues, 'parentPath') ? <p role="alert" className="n-field-error">{fieldMessage(issues, 'parentPath')}</p> : null}
          </div> : placeholder()}
        </SettingRow>
        {draft && query.isError ? <p role="alert" className="settings-note">Could not refresh. Your edits are kept.
          <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>Retry</Button></p> : null}
      </SettingsSection>
      {draft ? <SettingsFormActions form={form} saveLabel="Save workspace defaults" onSave={() => form.save(async (input) => {
        const response = await mutation.mutateAsync({ ...input, value: WorkspaceDefaultsSchema.parse(input.value) })
        return { value: response.value.value, revision: response.value.revision }
      }, (value) => WorkspaceDefaultsSchema.parse(value))} /> : null}
    </>}
  </section>
}
