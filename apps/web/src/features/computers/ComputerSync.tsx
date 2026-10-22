import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { useComputerSync } from '../../shared/api/computerSync'
import { Alert, Button, Skeleton, Switch } from '../../shared/ui/nocturne'

export function ComputerSyncPanel({ target, online = true }: { target: DeviceProvisioningTarget; online?: boolean }) {
  const state = useComputerSync(target)
  return <ComputerSyncContent state={state} online={online} />
}

/** One compact row per workspace: a switch, and a short status line. Status refreshes on its own. */
function ComputerSyncContent({ state, online }: { state: ReturnType<typeof useComputerSync>; online: boolean }) {
  const { status, update, change, retry, uncertain, refresh } = state
  if (status.isPending) return <Skeleton width="100%" height="2rem" />
  if (status.isError) return <p className="computer-sync-note">Sync status is unavailable. <Button size="sm" variant="ghost" onClick={() => void refresh()}>Retry</Button></p>
  return <>
      {/* An offline computer is already marked Offline; its "offline or needs an update" note repeats that. */}
      {status.data?.message && online && <p className="computer-sync-note">{status.data.message}</p>}
      {update.isError && <Alert tone="danger" title={update.error.message}>
        {uncertain && <Button size="sm" disabled={update.isPending} onClick={retry}>Retry sync save</Button>}
      </Alert>}
      {status.data?.folders.map(folder => <section key={folder.workspaceId} className="computer-sync-folder"
        aria-label={`Shared files for ${folder.name}`}>
        <Switch label={folder.name} checked={folder.enabled}
          disabled={update.isPending || update.isError}
          onChange={event => change(folder.workspaceId, event.target.checked, folder.revision)} />
        <small className="computer-sync-state" title={folder.status?.path}>
          {!folder.participating ? 'Starts when an Agent from this workspace runs here'
            : folder.status ? `${folder.status.connected ? 'Connected' : 'Disconnected'} · ${folder.status.state}` : ''}
        </small>
        {folder.status?.message && <p className="computer-sync-note" role="alert">{folder.status.message}</p>}
        {folder.status && folder.status.conflicts.length > 0 && <div><p>Conflicting copies need your review:</p>
          <ul>{folder.status.conflicts.map(file => <li key={file}>{file}</li>)}</ul></div>}
      </section>)}
      {status.data && !status.data.folders.length && <p className="computer-sync-note">No workspaces to sync yet.</p>}
  </>
}
