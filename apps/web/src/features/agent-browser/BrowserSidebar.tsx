import { useId, type ReactNode } from 'react'
import { Icon, IconButton } from '../../shared/ui/nocturne'
import './browserSidebar.css'

export type BrowserSidebarStatus = 'working' | 'idle' | 'ended' | 'not_started'
export interface BrowserSidebarTab { id: string; name: string; status: BrowserSidebarStatus; page?: string }

const statusLabel: Record<BrowserSidebarStatus, string> = { working: 'Working', idle: 'Idle', ended: 'Ended', not_started: 'No browser' }

/** Right-hand sidebar that shows only agent browsers: one tab per Agent, the selected tab's browser below. */
export function BrowserSidebar({ tabs, selectedId, emptyText, notice, onSelect, onCloseTab, onClose, children }: {
  tabs: readonly BrowserSidebarTab[]; selectedId?: string; emptyText: string; notice?: ReactNode
  onSelect(id: string): void; onCloseTab(id: string): void; onClose(): void; children?: ReactNode
}) {
  const id = useId()
  const selected = tabs.find(tab => tab.id === selectedId)
  return <aside className="browser-sidebar" aria-label="Agent browsers">
    <header className="browser-sidebar-head">
      <h2>Browsers</h2>
      <IconButton label="Close browsers" variant="ghost" size="sm" onClick={onClose}><Icon name="close" size={16} /></IconButton>
    </header>
    {tabs.length ? <div className="browser-sidebar-tabs" role="tablist" aria-label="Agent browsers">
      {tabs.map(tab => <div key={tab.id} className="browser-sidebar-tab" data-selected={tab.id === selectedId || undefined}>
        <button type="button" role="tab" id={`${id}-${tab.id}`} aria-selected={tab.id === selectedId} aria-controls={`${id}-panel`}
          title={tab.page ? `${tab.name} · ${tab.page}` : tab.name} onClick={() => onSelect(tab.id)}>
          <span className="browser-sidebar-dot" data-status={tab.status} aria-hidden="true" />
          <span className="browser-sidebar-name">{tab.name}</span>
          <span className="browser-sidebar-status">{statusLabel[tab.status]}</span>
        </button>
        <IconButton label={`Close ${tab.name} browser`} variant="ghost" size="sm" onClick={() => onCloseTab(tab.id)}>
          <Icon name="close" size={12} /></IconButton>
      </div>)}
    </div> : null}
    {notice}
    <div className="browser-sidebar-body" id={`${id}-panel`} role={selected ? 'tabpanel' : undefined}
      aria-labelledby={selected ? `${id}-${selected.id}` : undefined}>
      {selected ? children : <p className="browser-sidebar-empty">{tabs.length ? 'Choose an Agent above to watch its browser.' : emptyText}</p>}
    </div>
  </aside>
}
