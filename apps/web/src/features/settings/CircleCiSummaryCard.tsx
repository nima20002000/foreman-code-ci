import { Cloud } from 'lucide-react'
import { DEFAULT_CIRCLE_ACCOUNT_ID, type CircleAccountRead, type CircleOrganizationRead } from '@foreman-code/contracts/management'
import { useCircleAccountsQuery } from '../../shared/api/circleAccounts'
import { Alert, Badge, Button, Card, Skeleton } from '../../shared/ui/nocturne'

const NUMBER = new Intl.NumberFormat('en-US')
const ROLE_LABELS: Record<CircleOrganizationRead['schedulingRole'], string> = {
  active: 'Active',
  standby: 'Standby',
  exhausted: 'Out of credits',
}

/** One row per CircleCI organization. Long reasons live in tooltips, repeated ones are shown once. */
export function CircleCiSummaryCard() {
  const query = useCircleAccountsQuery()
  const accounts = query.data?.value.accounts
  const second = accounts?.find(account => account.id !== DEFAULT_CIRCLE_ACCOUNT_ID)
  return <section className="circleci-summary" aria-label="CircleCI">
    <Card>
      <header className="circleci-summary-header"><Cloud size={18} aria-hidden="true" /><h2>CircleCI</h2></header>
      {query.isPending && <div className="circleci-accounts" aria-busy="true"><Skeleton width="100%" height="4rem" /><Skeleton width="100%" height="4rem" /></div>}
      {query.isError && <Alert tone="danger" title="CircleCI accounts could not be read." live
        action={<Button size="sm" disabled={query.isFetching && !query.isRefetching} onClick={() => void query.refetch()}>
          Retry CircleCI
        </Button>} />}
      {query.isSuccess && <div className="circleci-accounts">
        <AccountSummary role="Primary" account={accounts?.find(account => account.id === DEFAULT_CIRCLE_ACCOUNT_ID)} />
        <AccountSummary role={second?.role === 'primary' ? 'Second' : 'Standby'} account={second} />
      </div>}
    </Card>
  </section>
}

function AccountSummary({ role, account }: { role: 'Primary' | 'Second' | 'Standby'; account: CircleAccountRead | undefined }) {
  // Reasons repeat per organization ("org: Log in to …"); show each distinct one once.
  const reasons = [...new Set(account?.reasons.map(reason => reason.replace(/^[\w-]+: /, '').replace(/\s*\([^)]*\)/g, '')) ?? [])]
  return <section className="circleci-account" aria-label={`${role} CircleCI account`}>
    <header><h3>{role}</h3>
      {account && account.label !== role ? <span className="circleci-account-label">{account.label}</span> : null}
      {account && !account.tokenConfigured ? <Badge tone="warning">Setup needed</Badge>
        : account && !account.ready ? <Badge tone="warning">Needs attention</Badge> : null}
    </header>
    {account ? <>
      {reasons.map(reason => <p className="circleci-summary-note" key={reason}>{reason}</p>)}
      {account.orgs.length > 0 ? <ul className="circleci-orgs" aria-label={`${role} organizations`}>
        {account.orgs.map(org => <OrganizationSummary key={`${org.circleAccountId}:${org.account}`} org={org} />)}
      </ul> : reasons.length ? null : <p className="circleci-summary-note">No organizations yet.</p>}
    </> : <p className="circleci-summary-note">No {role.toLowerCase()} account registered.</p>}
  </section>
}

function OrganizationSummary({ org }: { org: CircleOrganizationRead }) {
  return <li title={org.schedulingReason}>
    <strong>{org.account}</strong>
    <span>{org.running} {org.running === 1 ? 'job' : 'jobs'}</span>
    {org.credits
      ? <span title={`Updated ${readingAge(org.credits.asOf)}`}>≈ {NUMBER.format(org.credits.remaining)} credits</span>
      : <span className="circleci-muted" title={org.creditsUnavailable}>Credits unknown</span>}
    <Badge tone={!org.ready || org.schedulingRole === 'exhausted' ? 'warning' : 'neutral'}>
      {org.ready ? ROLE_LABELS[org.schedulingRole] : 'Not ready'}
    </Badge>
  </li>
}

function readingAge(asOf: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(asOf)) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h ago`
  return `${Math.floor(minutes / 1440)} d ago`
}
