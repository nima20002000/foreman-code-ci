import { Link } from '@tanstack/react-router'
import { EmptyState } from './nocturne'

/** Shown for any address that matches no page. */
export function PageNotFound() {
  return <div className="n-theme page-not-found"><EmptyState title="Page not found" description="This address doesn't match a page."
    action={<Link to="/workspaces" className="n-button n-button--secondary">Go to workspaces</Link>} /></div>
}
