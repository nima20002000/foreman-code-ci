import { memo, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import type { Components } from 'react-markdown'
import type { Message } from '@foreman-code/contracts'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { useMutation } from '@tanstack/react-query'
import { errorMessage } from '../../../shared/errorMessage'
import { Button, CodeBlock, MessageBubble } from '../../../shared/ui/nocturne'
import { TextTruncationNotice } from '../TextTruncationNotice'

const markdownComponents: Components = {
  pre({ node }) {
    const code = node?.children[0]
    if (code?.type !== 'element') return null
    const text = code.children.map(child => child.type === 'text' ? child.value : '').join('')
    const classes = code.properties.className
    const language = Array.isArray(classes)
      ? classes.map(String).find(value => value.startsWith('language-'))?.slice(9) : undefined
    return <CodeBlock code={text.replace(/\n$/, '')} label="Code" language={language ?? 'text'} />
  },
  a({ children, href }) {
    return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
  },
  img({ alt }) {
    return <span>{alt}</span>
  },
}

const AgentMarkdown = memo(function AgentMarkdown({ content }: { content: string }) {
  return <Markdown components={markdownComponents} skipHtml>{content}</Markdown>
})

export function AgentChatMessage({ message, name, status, actions, children, onExpand }: {
  message: Omit<Message, 'conversationId'>
  name: string
  status?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  onExpand?(): Promise<void>
}) {
  const user = message.role === 'user'
  const timestamp = message.createdAt
  const time = timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : undefined
  if (message.role === 'tool') return <details className="agent-chat-tool">
    <summary>Tool output</summary><CodeBlock code={message.content} label="Tool output" />
    <TextTruncationNotice truncation={message.truncation} />{children}
  </details>
  // Same look as the Operator chat: avatar and name above, the reply in a bubble; time shows on hover.
  return <div className={`agent-chat-message agent-chat-message--${user ? 'user' : 'agent'}`} data-message-role={message.role}
    title={timestamp ? new Date(timestamp).toLocaleString() : undefined}>
    <MessageBubble author={user ? 'You' : name} role={user ? 'user' : 'assistant'} status={status} actions={actions}
      {...(time ? { time, dateTime: timestamp } : {})}>
      <div className={user ? undefined : 'agent-chat-answer'}>
        <div className="conversation-message-content">{user ? message.content : <AgentContent content={message.content} />}</div>
      </div>
      <TextTruncationNotice truncation={message.truncation} />
      {message.truncation?.truncated && onExpand ? <MessageExpansion key={`${message.id}:${message.revision}`}
        onExpand={onExpand} /> : null}
      {children}
    </MessageBubble>
  </div>
}

function MessageExpansion({ onExpand }: { onExpand(): Promise<void> }) {
  const expansion = useMutation({ mutationFn: onExpand, retry: false })
  return <>
    {!expansion.isSuccess ? <Button size="sm" variant="ghost" disabled={expansion.isPending}
      onClick={() => expansion.mutate()}>{expansion.isPending ? 'Loading full message…' : 'Show full message'}</Button> : null}
    {expansion.isError ? <p role="alert">{errorMessage(expansion.error, 'The full message could not be loaded.')}</p> : null}
  </>
}

/** A structured turn result (routing, board patches) reads as its summary line; the JSON stays one click away. */
function AgentContent({ content }: { content: string }) {
  const result = structuredResult(content)
  if (!result) return <AgentMarkdown content={content} />
  return <>
    {result.summary ? <AgentMarkdown content={result.summary} /> : <p>Turn finished.</p>}
    <details className="agent-chat-tool"><summary>Result details</summary>
      <CodeBlock code={JSON.stringify(result.value, null, 2)} label="Result details" /></details>
  </>
}

/** True when both messages carry the same structured turn result; Claude can repeat its final result as a second message. */
export function sameStructuredResult(left: string, right: string): boolean {
  const first = structuredResult(left), second = structuredResult(right)
  return !!first && !!second && canonicalJson(first.value) === canonicalJson(second.value)
}

const summaryKeys = ['summary', 'body', 'message', 'reason', 'text'] as const
function structuredResult(content: string): { value: unknown; summary: string | undefined } | undefined {
  const text = content.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1')
  if (!text.startsWith('{')) return undefined
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined } // ignore: plain text that merely starts with a brace
  if (!value || typeof value !== 'object' || !('routing' in value || 'board' in value || 'result' in value)) return undefined
  return { value, summary: findSummary(value, 0) }
}
function findSummary(value: unknown, depth: number): string | undefined {
  if (depth > 6 || !value || typeof value !== 'object') return undefined
  for (const key of summaryKeys) {
    const field = (value as Record<string, unknown>)[key]
    if (typeof field === 'string' && field.trim()) return field
  }
  for (const child of Object.values(value)) {
    const found = findSummary(child, depth + 1)
    if (found) return found
  }
  return undefined
}
