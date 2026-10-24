import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { useComputerMaintenance } from '../../shared/api/computerMaintenance'
import { Button } from '../../shared/ui/nocturne'
import { askOperator } from '../operator-chat'
import { ComputerStatusChips } from './ComputerStatusChips'
import { deriveStatusChips } from './statusChips'

export function ComputerDefaultSignIns({ target, computer, online }: {
  target: DeviceProvisioningTarget; computer: string; online: boolean
}) {
  const read = useComputerMaintenance([target])[0]!
  const chips = deriveStatusChips({ accounts: read.data?.connections?.accounts,
    connections: read.data?.connections, status: read.data?.status, readiness: undefined, starting: false })
    .filter(chip => chip.id === 'codex' || chip.id === 'claude')
  return <section aria-label="Default sign-ins">
    <h3>Default sign-ins</h3>
    {!online ? <p>Computer offline. Last observed sign-ins:</p> : null}
    {read.isError || read.data?.observation?.status === 'unavailable' ? <p>Default sign-ins are unavailable.
      <Button size="sm" variant="ghost" onClick={() => void read.refetch()}>Recheck sign-ins</Button>
    </p> : <ComputerStatusChips chips={chips} computer={computer}
      onSignIn={tool => askOperator(`Sign ${tool} in on ${computer}.`)} />}
  </section>
}
