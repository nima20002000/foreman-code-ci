import { PromptTextSchema, type PromptText } from '@foreman-code/contracts/management'
import {
  usePromptSettingQuery,
  useUpdatePromptSettingMutation,
  type PromptSettingsPage,
} from '../../shared/api/promptSettings'
import { useLocalHumanAccessQuery } from '../../shared/api/settingsExperience'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import { ProtectedAccessError } from '../../shared/ui/ProtectedAccessError'
import { Alert, Button, ErrorState, Skeleton, Textarea } from '../../shared/ui/nocturne'
import { fieldMessage } from './fieldValidation'
import { SettingsFormActions } from './SettingsFormActions'
import { useRevisionedForm } from './revisionedForm'
import './settingsExperience.css'

const presentation = {
  'system-prompt': {
    title: 'System prompt',
    label: 'System prompt',
    help: 'Newly started agent sessions use this prompt.',
  },
  'operator-initial-prompt': {
    title: 'Operator · Initial prompt',
    label: 'Initial prompt',
    help: 'New Operator conversations start with this prompt.',
  },
}

/** One prompt: a title, one line on where it applies, a full-width editor and right-aligned Discard and Save. */
export function PromptSettings({ page }: { page: PromptSettingsPage; onBack?(): void }) {
  const query = usePromptSettingQuery(page)
  const mutation = useUpdatePromptSettingMutation(page)
  const access = useLocalHumanAccessQuery()
  const form = useRevisionedForm<PromptText>(query.data, `settings:${page}`)
  const promptAccessError = useProtectedAccessError(query, mutation.error)
  const localAccessError = useProtectedAccessError(access)
  const info = presentation[page]
  const canEdit = Boolean(access.isSuccess && Date.parse(access.data.principal.expiresAt) > Date.now()
    && access.data.principal.grants.some(grant => grant.actions.includes('settings:update')
      && !grant.scope.workspaceIds && !grant.scope.workflowIds && !grant.scope.runIds))
  const accessError = promptAccessError ?? localAccessError
  const actions = <SettingsFormActions form={form} canSave={canEdit && !accessError}
    saveLabel={`Save ${info.label.toLowerCase()}`}
    onSave={() => form.save(async input => {
      const response = await mutation.mutateAsync(input)
      return response.value
    }, value => PromptTextSchema.parse(value))} />
  if (accessError) return <><ProtectedAccessError error={accessError} />{actions}</>
  const draft = form.draft
  return <section className="settings-editor-page prompt-settings" aria-label={`${info.label} settings`}>
    <header className="settings-experience-heading">
      <h1>{info.title}</h1>
      <p>{info.help}</p>
    </header>
    {query.isError && !draft ? <ErrorState title={`${info.label} is unavailable`} description="Try again in a moment." onRetry={() => void query.refetch()} /> : null}
    {query.isError && draft ? <Alert tone="warning" title="Couldn’t refresh the saved prompt. Your edits are kept."
      action={<Button size="sm" disabled={query.isFetching || form.isSaving || form.uncertain} onClick={() => void query.refetch()}>Refresh saved prompt</Button>} /> : null}
    {access.isError ? <Alert tone="warning" title="Couldn’t check editing access."
      action={<Button size="sm" onClick={() => void access.refetch()}>Retry</Button>} /> : null}
    {form.conflicted ? <Alert tone="warning" title="This prompt changed elsewhere. Your edits are preserved."
      action={<div className="settings-defaults-conflict-actions">
        <Button size="sm" disabled={!canEdit || form.uncertain} onClick={form.reapply}>Keep my text with the current revision</Button>
        <Button size="sm" variant="ghost" disabled={form.uncertain} onClick={form.reset}>Load saved prompt</Button>
      </div>}>
      <details><summary>Current saved prompt</summary><pre className="prompt-settings-saved">{query.data?.value.text}</pre></details>
    </Alert> : null}
    {form.uncertain ? <Alert live tone="warning" title="Save not confirmed">{form.checking
      ? 'Checking again by itself until the app answers.' : 'Retry to check it.'} Your edits are kept.</Alert> : null}
    {form.error && !form.conflicted && !form.uncertain ? <Alert live tone="danger" title="Prompt was not saved">
      {form.error} Your edits are still here.
    </Alert> : null}
    {draft ? <Textarea label={info.label} className="prompt-settings-field" rows={14} value={draft.text} maxLength={PromptTextSchema.shape.text.maxLength ?? undefined}
      readOnly={!canEdit} disabled={form.isSaving || form.uncertain} error={fieldMessage(form.issues ?? [], 'text')}
      onChange={event => form.setDraft({ text: event.target.value })} />
      : !query.isError ? <Skeleton width="100%" height="18rem" /> : null}
    {draft && !canEdit && !access.isPending ? <p role="status" className="settings-note">You have read-only access to this prompt.</p> : null}
    <div className="prompt-settings-footer">
      {form.savedRevision !== undefined && !form.error ? <p role="status" className="settings-saved-note">Prompt saved</p> : null}
      {draft ? actions : null}
    </div>
  </section>
}
