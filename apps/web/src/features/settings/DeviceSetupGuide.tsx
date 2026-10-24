import { InfoHint } from '../../shared/ui/InfoHint'
import type { DeviceRegistration } from '@foreman-code/contracts/device-identity'
import { useTrustedConnection } from '../../shared/api/trustedConnection'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import { Button } from '../../shared/ui/nocturne'
import { askOperator } from '../operator-chat'

/** Static guidance shown before a request code exists. It never installs, logs in or changes a network. */
export function DeviceSetupGuide() {
  return <section className="device-setup-guide" aria-label="Before you add a computer">
    <h3>Before you add a computer</h3>
    <ol className="computer-steps">
      <li><strong>Install the companion on the remote computer first.</strong> <InfoHint label="Computer request code">Its request code only exists after the companion is installed and opened there.</InfoHint>
        <InfoHint label="Pairing">Pairing lets the computer connect and send heartbeats to this main. Pairing authorizes connection changes; connection readiness is checked separately.</InfoHint></li>
      <li><strong>Set up the connection with the Operator.</strong> Once paired, ask the Operator to configure the connection and choose which user it runs as.</li>
      <li><strong>Check connection readiness.</strong> <InfoHint label="Connection readiness">Readiness comes from a verified connection, not from registration or inventory.</InfoHint></li>
    </ol>
    <details className="computer-details"><summary>Network prerequisites</summary>
      <ul className="computer-diagnostics">
        <li>SSH and rsync must already be installed and working on the remote computer.</li>
        <li>The remote computer must be reachable from this main over your LAN or, optionally, over Tailscale.</li>
        <li>If you use Tailscale, install it and sign in yourself on each computer; this page does not install it or change network settings.</li>
        <li>Compare the computer and main fingerprints shown when you confirm details. Do not approve if they differ from what each machine displays.</li>
      </ul>
    </details>
  </section>
}

/** Pairing alone does not establish connection readiness. */
export function ConnectionSetupStatus({ registration }: { registration: DeviceRegistration }) {
  if (registration.status === 'paired') return <PairedConnection registration={registration} />
  return <section className="device-setup-status" aria-label="Remote command connection" data-state={registration.status === 'revoked' ? 'blocked' : 'needs-pairing'}>
    <p role="status">{registration.status === 'revoked'
      ? <><strong>Blocked.</strong> This computer’s registration is revoked, so no connection can be set up.</>
      : <><strong>Pairing needed.</strong> Pair this computer before any connection can be set up.</>}</p>
  </section>
}

function PairedConnection({ registration }: { registration: DeviceRegistration }) {
  const query = useTrustedConnection(registration)
  const denied = useProtectedAccessError(query)
  const result = denied ? undefined : query.data
  const labels = {
    ready: 'Connection ready.', offline: 'Connection offline.', 'tools-missing': 'Connection tools missing.',
    'pairing-required': 'Pairing needed.', revoked: 'Registration revoked.', 'consent-required': 'Connection setup needed.',
    'consent-revoked': 'Connection disabled.', 'identity-changed': 'Computer identity changed.',
    'authentication-required': 'Connection sign-in required.', 'host-key-mismatch': 'Connection identity mismatch.',
    'host-key-untrusted': 'Connection identity unverified.', 'permission-denied': 'Connection access denied.',
    unavailable: 'Connection status unavailable.',
  } as const
  return <section className="device-setup-status" aria-label="Remote command connection" data-state={result?.state ?? 'unverified'}>
    <p role="status">{result ? <>
      {query.isError ? 'Last checked: ' : null}<strong>{labels[result.state]}</strong>
      {' '}Checked <time dateTime={result.checkedAt}>{new Date(result.checkedAt).toLocaleString()}</time>.
    </> : <><strong>Connection status unverified.</strong> This computer is paired. Ask the Operator to read and configure its connection, then check readiness.</>}</p>
    {query.isError ? <p role="alert">{query.error.message} Check the connection again.</p> : null}
    <Button size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>Check connection</Button>
    <Button size="sm" onClick={() => askOperator(`Set up and check the connection to computer ${registration.deviceId} on Main ${registration.mainId}: `, { send: false })}>Ask Operator</Button>
  </section>
}
