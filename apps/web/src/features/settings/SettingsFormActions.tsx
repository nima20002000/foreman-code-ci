import { useContext, useEffect, useRef, type ReactNode } from 'react'
import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { Alert, Button } from '../../shared/ui/nocturne'
import { ToastContext } from '../../shared/ui/nocturne/toastContext'
import type { SettingsChange } from './revisionedFormChanges'
import './settingsUsability.css'

interface SettingsFormState {
  isDirty: boolean
  isSaving: boolean
  uncertain: boolean
  /** The unconfirmed save is being resent by itself until the app answers. */
  checking?: boolean
  conflicted: boolean
  error?: string
  savedRevision?: number
  serverChanges: SettingsChange[]
  localChanges: SettingsChange[]
  reset(): void
  reapply(): void
}

export function SettingsFormFeedback({ form }: { form: SettingsFormState }) {
  return <>
    {form.conflicted ? <div className="settings-form-feedback" role="alert">
      <Alert tone="warning" title="These settings changed elsewhere. Your edits are kept."
        action={<div className="settings-defaults-conflict-actions">
          <Button size="sm" disabled={form.isSaving || form.uncertain} onClick={form.reapply}>Keep my edits</Button>
          <Button size="sm" variant="ghost" disabled={form.isSaving || form.uncertain} onClick={form.reset}>Load latest</Button>
        </div>} />
    </div> : null}
    {form.uncertain ? <div className="settings-form-feedback"><Alert live tone="warning" title={form.checking
      ? 'Save not confirmed yet. Checking again by itself…' : 'Save not confirmed. Retry to check it.'} /></div> : null}
    {form.error && !form.conflicted && !form.uncertain ? <div className="settings-form-feedback"><Alert live tone="danger" title="Couldn’t save">
      {form.error} Your edits are still here.
    </Alert></div> : null}
    {form.savedRevision !== undefined && !form.error && !form.uncertain ? <p role="status" className="settings-saved-note">
      {form.isDirty ? 'Earlier changes saved. Newer edits are still unsaved.' : 'Saved.'}</p> : null}
  </>
}

export function SettingsFormActions({ form, onSave, saveLabel = 'Save defaults', extra, canSave = true }: {
  form: SettingsFormState; onSave(): unknown | Promise<unknown>;
  saveLabel?: string; extra?: ReactNode; canSave?: boolean;
}) {
  const save = () => {
    if (!canSave) return false
    return onSave()
  }
  useUnsavedChanges({ label: saveLabel.replace(/^Save /, ''), dirty: form.isDirty, busy: form.isSaving,
    uncertain: form.uncertain, saveDisabled: !canSave || (form.conflicted && !form.uncertain),
    error: form.conflicted ? 'These settings changed elsewhere. Keep editing to review and resolve the conflict.' : form.error,
    save, discard: form.reset })
  const subject = saveLabel.replace(/^Save /, '')
  const subjectTitle = subject.charAt(0).toUpperCase() + subject.slice(1)
  const toasts = useContext(ToastContext)
  const warning = useRef<string | undefined>(undefined)
  useEffect(() => () => { if (warning.current) toasts?.dismiss(warning.current) }, [toasts])
  const previous = useRef({ revision: form.savedRevision, error: form.error, uncertain: form.uncertain,
    conflicted: form.conflicted, saving: form.isSaving })
  useEffect(() => {
    const before = previous.current
    if (toasts) {
      const notifyWarning = (input: Parameters<typeof toasts.notify>[0]) => {
        if (warning.current) toasts.dismiss(warning.current)
        warning.current = toasts.notify(input)
      }
      if (!form.isSaving && !form.uncertain && !form.conflicted && !form.error && warning.current) {
        toasts.dismiss(warning.current)
        warning.current = undefined
      }
      if (form.uncertain && !before.uncertain) notifyWarning({ tone: 'warning', title: 'Save not confirmed',
        description: form.checking ? 'Checking again by itself until the app answers. Your edits are kept.'
          : 'Retry the original save to learn whether it committed.' })
      else if (form.conflicted && !before.conflicted) notifyWarning({ tone: 'warning', title: `${subjectTitle} changed elsewhere`,
        description: 'Review the changes before saving again.' })
      else if (form.error && !form.conflicted && (form.error !== before.error || before.saving)) {
        notifyWarning({ tone: 'danger', title: `Could not save ${subject}`, description: form.error })
      } else if (form.savedRevision !== undefined && form.savedRevision !== before.revision) {
        toasts.notify({ tone: 'success', title: `${subjectTitle} saved`,
          ...(form.isDirty ? { description: 'Newer edits are still unsaved.' } : {}) })
      }
    }
    previous.current = { revision: form.savedRevision, error: form.error, uncertain: form.uncertain,
      conflicted: form.conflicted, saving: form.isSaving }
  }, [form.savedRevision, form.error, form.uncertain, form.checking, form.conflicted, form.isSaving, form.isDirty, subject, subjectTitle, toasts])
  if (!canSave) return null
  return <footer className="settings-save-actions">
    {extra ? <div className="settings-footer-options">{extra}</div> : null}
    {form.isDirty && !form.conflicted ? <Button variant="ghost" disabled={!form.isDirty || form.isSaving || form.uncertain} onClick={form.reset}>Discard</Button> : null}
    <Button variant="primary" aria-label={saveLabel} loading={form.isSaving} loadingLabel="Saving…" disabled={(!form.isDirty && !form.uncertain) || (form.conflicted && !form.uncertain)} onClick={save}>
      {form.uncertain ? 'Retry original save' : 'Save'}
    </Button>
  </footer>
}
