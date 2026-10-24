import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { useRememberedChatScroll } from '../chat-core'

/** Shared transcript scrolling, following the Operator transcript pattern. No server data lives here. */
export function ConversationViewport({ revision, children, storageKey }: {
  revision: string; children: (onBrowse: () => void) => ReactNode; storageKey?: string
}) {
  const scrollRef = useRef<HTMLDivElement>(null), contentRef = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  useRememberedChatScroll(storageKey, scrollRef, following)
  const onBrowse = () => { following.current = false }
  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    if (following.current) scroll.scrollTop = scroll.scrollHeight
  }, [revision])
  useLayoutEffect(() => {
    if (!contentRef.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const scroll = scrollRef.current
      if (scroll && following.current) scroll.scrollTop = scroll.scrollHeight
    })
    observer.observe(contentRef.current)
    return () => observer.disconnect()
  }, [])
  return <div className="conversation-viewport">
    <div ref={scrollRef} className="conversation-viewport-scroll" role="region" aria-label="Agent conversation transcript" tabIndex={0}
      onScroll={(event) => {
        const scroll = event.currentTarget
        following.current = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 48
      }}>
      <div ref={contentRef}>{children(onBrowse)}</div>
    </div>
  </div>
}
