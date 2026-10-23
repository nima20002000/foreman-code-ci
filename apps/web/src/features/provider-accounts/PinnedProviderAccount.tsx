import type { AcceptedProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import { Button } from '../../shared/ui/nocturne'
import { useProviderAccount, useProviderAccountDetails } from './providerAccountsQueries'
import './providerAccounts.css'

export function PinnedProviderAccount({ binding, label = 'Saved account' }: {
  binding?: AcceptedProviderAccountBinding | undefined; label?: string;
}) {
  const query = useProviderAccount(binding?.kind === 'slot' ? binding : undefined)
  const denied = useProtectedAccessError(query)
  const account = query.isError || denied ? undefined : query.data
  // A legacy profile is shown by its account's name, never by its internal profile reference.
  const legacy = useProviderAccountDetails(binding?.kind === 'legacy-profile' ? binding.accountId : undefined)
  const legacyName = legacy.isError ? undefined : legacy.data?.name
  if (!binding) return <p className="pinned-provider-account">{label}: not recorded.</p>
  if (binding.kind === 'legacy-profile') return <p className="pinned-provider-account">{label}: {legacyName
    ? <><strong>{legacyName}</strong> · {binding.provider}</> : binding.provider}</p>
  const target = binding.target
  const unavailable = !account || Boolean(account.removedAt) || account.status === 'unavailable'
  return <section className="pinned-provider-account" aria-label={label}>
    <p>{label}: <strong>{account?.name ?? binding.accountId}</strong> · {binding.provider}</p>
    <p>{target.hostRef.kind === 'main' ? 'Main' : 'Worker'} · {target.hostRef.kind === 'main'
      ? target.hostRef.mainId : target.hostRef.deviceId} · Installation {target.applicationInstallationId}</p>
    {binding.subject ? <p>Provider identity recorded at acceptance: {binding.subject.subject}</p>
      : <p>Provider identity at acceptance is unknown.</p>}
    {query.isPending ? <p role="status">Reading the saved account…</p> : null}
    {!query.isPending && unavailable ? <p role="status">{account?.removedAt ? 'This account was removed from selection.'
      : 'The original account is unavailable.'} Restore access to its original computer and profile to continue this work.</p> : null}
    {query.isError && !denied ? <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>Recheck saved account</Button> : null}
  </section>
}
