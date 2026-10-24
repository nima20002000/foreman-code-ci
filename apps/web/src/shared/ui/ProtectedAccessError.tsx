import { Button } from './nocturne'
import { ApiError } from '../api/client'

export function ProtectedAccessError({ error, onRetry }: { error: ApiError; returnTo?: string; onRetry?(): void }) {
  return <section role="alert" className="access-message">
    <h1>Access unavailable</h1><p>{error.message}</p>
    {onRetry ? <Button onClick={onRetry}>Recheck access</Button> : <p>Refresh this page after checking the local API connection.</p>}
  </section>
}
