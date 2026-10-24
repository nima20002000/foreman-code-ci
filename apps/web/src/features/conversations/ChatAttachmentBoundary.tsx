import { useContext, type ReactNode } from 'react'
import { AttachmentDraftProvider, createAttachmentHttpClient, AttachmentDraftContext } from '../attachments'
import { sessionGeneration } from '../../shared/api/sessionBoundary'

const attachmentClient = createAttachmentHttpClient()

/** The authenticated shell owns the production lifetime, above every keyed chat panel.
 * Standalone embeddings use the same boundary without nesting a second draft store. */
export function ChatAttachmentBoundary({ children }: { children: ReactNode }) {
  const existing = useContext(AttachmentDraftContext)
  return existing ? children : <AttachmentDraftProvider key={sessionGeneration()} client={attachmentClient}>
    {children}
  </AttachmentDraftProvider>
}
