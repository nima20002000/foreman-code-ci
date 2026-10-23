import { create } from 'zustand'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { ComputerCards } from '../computers'
import { useRegisteredComputersQuery, useSelectedMainQuery } from '../../shared/api/computerSettings'
import { Alert, Button, LoadingState } from '../../shared/ui/nocturne'
import { ComputerDetailSettings } from './ComputerDetailSettings'
import { ComputerPairingForm } from './ComputerPairingForm'
import { CircleCiSummaryCard } from './CircleCiSummaryCard'
import './computerSettings.css'

/** Which main's Add computer panel is open, keyed by session generation and main so a new session or main starts closed. */
const useAddPanel = create<{ scope?: string; toggle(scope: string): void }>(set => ({
  toggle: scope => set(state => ({ scope: state.scope === scope ? undefined : scope })),
}))

/** The Computers list, or one computer's own settings page ('main' for the Main PC). */
export function ComputerSettings({ deviceId, onSelectComputer }: { deviceId?: string; onSelectComputer?(deviceId: string): void }) {
  const main = useSelectedMainQuery()
  const currentMain = main.isSuccess ? main.data : undefined
  const computers = useRegisteredComputersQuery(currentMain?.mainId)
  const devices = computers.isSuccess ? computers.data.devices : []
  const registration = devices.find(value => value.deviceId === deviceId)
  const addScope = useAddPanel(state => state.scope)
  const toggleAdd = useAddPanel(state => state.toggle)
  const adding = currentMain !== undefined && addScope === `${sessionGeneration()}:${currentMain.mainId}`
  const readFailure = main.isError ? <Alert tone="danger" title="Couldn’t read the Main PC."
    action={<Button size="sm" onClick={() => void main.refetch()}>Retry</Button>} />
    : computers.isError ? <Alert tone="danger" title="Couldn’t read computers."
      action={<Button size="sm" onClick={() => void computers.refetch()}>Retry</Button>} /> : null
  const loading = !currentMain || computers.isPending ? <LoadingState label="Loading computers…" rows={2} /> : null
  if (deviceId) return readFailure ?? loading ?? (deviceId === 'main' || registration
    ? <ComputerDetailSettings mainId={currentMain!.mainId} devices={devices} registration={registration} />
    : <Alert tone="warning" title="This computer isn't paired with this Main PC." />)
  return <section className="settings-editor-page computers-page" aria-label="Computers">
    <header className="computers-header"><div className="settings-experience-heading"><h1>Computers</h1></div>
      {currentMain ? <Button variant="primary" aria-expanded={adding} aria-controls="computer-add-panel" onClick={() => toggleAdd(`${sessionGeneration()}:${currentMain.mainId}`)}>{adding ? 'Close' : 'Add computer'}</Button> : null}</header>
    {currentMain ? <div id="computer-add-panel" className="computers-panel" hidden={!adding}><ComputerPairingForm key={currentMain.mainId} mainId={currentMain.mainId} /></div> : null}
    {readFailure ?? loading ?? <ComputerCards mainId={currentMain!.mainId} devices={devices} onSelectComputer={onSelectComputer} />}
    <CircleCiSummaryCard />
  </section>
}
