import type { OperatorChatSetup } from '@foreman-code/contracts'
import { ExecutionReadinessNotice } from './ExecutionReadinessNotice'
import { Button } from '../../shared/ui/nocturne'
import { ChatNotice } from '../conversations/ChatNotice'
import { ApiError } from '../../shared/api/client'

export function OperatorSetupNotice({ data, checking, failed, error, onRetry }: {
  data?: OperatorChatSetup; checking: boolean; failed: boolean; error?: unknown; onRetry(): void;
}) {
  // A profile that is still being checked is not a failure; the setup read retries by itself.
  if (failed && ApiError.is(error) && error.code === 'HARNESS_PROFILE_CHECK_PENDING') return <ChatNotice tone="info" title="Checking the Operator’s tools…" />
  // A failed check stays visible while it retries, so background retries do not make it flicker.
  if (failed) return <ChatNotice title="Operator tools unavailable"
    action={<Button size="sm" onClick={onRetry}>Check again</Button>}>
    The Operator could not reach its tools. It retries by itself.
  </ChatNotice>
  if (!data) return null
  if (data.harness === 'opencode') return <ChatNotice title="Retired harness (OpenCode): read-only" tone="info" />
  if (data.status === 'configured') return <ExecutionReadinessNotice harness={data.harness} configurationVersionId={data.configurationVersionId} />
  const name = data.harness === 'claude' ? 'Claude' : 'Codex'
  return <ChatNotice title={`Install Foreman Code MCP in ${name} first`}
    action={<><a className="n-button n-button--secondary n-button--sm"
      href={`/settings/harnesses?harness=${data.harness}&section=connections`}>Open Harness Settings</a>
      <Button size="sm" disabled={checking} loading={checking} onClick={onRetry}>Check again</Button></>}>
    {data.reason ?? "Operator chat needs the enabled Foreman Code MCP connection to use the app’s tools."}
  </ChatNotice>
}
