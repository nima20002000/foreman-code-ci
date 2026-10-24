import { useState } from 'react'
import type { DeviceRegistration } from '@foreman-code/contracts/device-identity'
import { Button } from '../../shared/ui/nocturne'
import { ComputerPairingForm } from './ComputerPairingForm'

/** A lost one-use secret is replaced through the existing revoke and re-enrollment flow. */
export function ComputerPairingRecovery({ registration }: { registration: DeviceRegistration }) {
  const [recovering, setRecovering] = useState(false)
  if (registration.status === 'revoked') return <ComputerPairingForm mainId={registration.mainId} workerInstallationId={registration.workerInstallationId} />
  if (registration.status !== 'pending') return null
  return <>
    <p>Enter the private pairing code in the companion to finish pairing. If the code expired or was lost, start again here.</p>
    {recovering ? <p role="status">Revoke worker access below to invalidate the old code. Then paste this computer’s request code here for a new pairing code.</p>
      : <Button size="sm" onClick={() => setRecovering(true)}>Start pairing again</Button>}
  </>
}
