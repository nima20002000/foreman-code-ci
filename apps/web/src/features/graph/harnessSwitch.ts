import {
  DEFAULT_HARNESS_DEFAULTS, validateHarnessWorkflowCompatibility, withAdvancedDefaults,
  type AgentHarness, type ApprovalHandler, type RecordedHarnessConfiguration, type HarnessDefaults,
} from '@foreman-code/contracts'
import { prepareHarnessEditor, switchHarnessEditor, type HarnessEditor } from '../settings'

type Workflow = { approvalHandler?: ApprovalHandler | undefined; designatedOrchestrator: boolean }

/** The starting settings for a harness the user switches to: the role's default when it uses that harness,
 * otherwise the harness preset, adjusted so the workflow accepts it. Nothing from the old harness carries over. */
export function harnessSwitchPreset(next: AgentHarness, roleDefault: RecordedHarnessConfiguration | undefined,
  presets: Partial<HarnessDefaults> | undefined, workflow: Workflow): RecordedHarnessConfiguration | undefined {
  // Without a preset (Claude has no built-in one) only an earlier draft of that harness can be restored.
  const source: RecordedHarnessConfiguration | undefined = roleDefault?.harness === next ? roleDefault
    : presets?.[next] ?? (DEFAULT_HARNESS_DEFAULTS as Partial<HarnessDefaults>)[next]
  if (!source) return undefined
  const base = withAdvancedDefaults(source)
  if (base.harness === 'claude') return { ...base, sandbox: 'danger-full-access' }
  if (base.harness !== 'codex' || !base.advanced) return base
  const advanced = { ...base.advanced }
  const handler = workflow.approvalHandler
  if (handler) advanced.sessionPersistence = 'persistent'
  if (handler === 'native') advanced.approvalPolicy = 'never'
  if (advanced.approvalsReviewer === 'auto_review' && handler !== 'orchestrator' && handler !== 'native') advanced.approvalsReviewer = 'user'
  if (workflow.designatedOrchestrator && advanced.approvalsReviewer === 'auto_review') advanced.approvalPolicy = 'on-request'
  return { ...base, advanced }
}

function workflowAccepts(editor: HarnessEditor, workflow: Workflow): boolean {
  try {
    validateHarnessWorkflowCompatibility(prepareHarnessEditor(editor), workflow.approvalHandler, workflow.designatedOrchestrator)
    return true
  } catch {
    // ignore: an earlier draft of this harness that the workflow rejects is replaced by fresh defaults.
    return false
  }
}

/** Switch harness, restoring this visit's earlier edits for that harness only while they are still valid. */
export function switchAgentHarness(editor: HarnessEditor, next: AgentHarness, preset: RecordedHarnessConfiguration | undefined, workflow: Workflow): HarnessEditor {
  const draft = editor.drafts?.[next]
  if (draft && !workflowAccepts(draft, workflow)) {
    const drafts = { ...editor.drafts }
    delete drafts[next]
    return switchHarnessEditor({ ...editor, drafts }, next, preset)
  }
  return switchHarnessEditor(editor, next, preset)
}
