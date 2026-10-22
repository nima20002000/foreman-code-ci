import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon, IconButton, Tooltip } from '../../../shared/ui/nocturne'
import { usePanelFooterSlot, usePanelHeaderSlot } from '../../../shared/ui/panelHeaderSlot'

export function AgentChatHeader({ name, state, detail, controls, onClose }: {
  name: string; state: string; detail?: string; controls?: ReactNode; onClose?: () => void
}) {
  const chip = <span className="agent-chat-session-label" data-state={state} role="status" aria-label="Agent state"
    tabIndex={detail ? 0 : undefined}>{state}</span>
  const slot = usePanelHeaderSlot()
  const footer = usePanelFooterSlot()
  const status = <>
    {detail ? <Tooltip content={detail}>{chip}</Tooltip> : chip}
    {controls ? <div className="agent-chat-header-controls">{controls}</div> : null}
  </>
  // Inside a floating panel the name joins the panel's header and the context meter its footer, below the composer;
  // the state chip is left out there.
  if (slot) return <header className="agent-chat-header agent-chat-header--slotted"><div className="agent-chat-identity"><h2>{name}</h2></div>
    {createPortal(<strong className="agent-chat-header-name">{name}</strong>, slot)}
    {footer && controls ? createPortal(<div className="agent-chat-header-controls">{controls}</div>, footer) : null}</header>
  return <header className="agent-chat-header"><nav aria-label={`${name} chat controls`}>
    <div className="agent-chat-identity"><h2>{name}</h2></div>
    {status}
    {onClose ? <IconButton className="agent-chat-close" label={`Close ${name}`} variant="ghost" onClick={onClose}>
      <Icon name="close" />
    </IconButton> : null}
  </nav></header>
}

export function AgentChatStatus({ children }: { children?: ReactNode }) {
  return children ? <div className="agent-chat-status" role="status">{children}</div> : null
}
