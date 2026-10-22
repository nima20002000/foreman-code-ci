import { Link } from '@tanstack/react-router'
import { Button } from '../../../shared/ui/nocturne'
import { useCreateWorkspaceFolder } from '../../../shared/api/harnessSettings'
import { errorMessage } from '../../../shared/errorMessage'

/** Actions for a chat whose saved workspace folder on Main no longer exists: recreate it empty, or pick another. */
export function MissingChatFolderActions({ workspaceId, path, onRecreated }: {
  workspaceId: string; path: string; onRecreated: () => void
}) {
  const create = useCreateWorkspaceFolder()
  const slash = path.lastIndexOf('/')
  const recreate = () => create.mutate({ parentPath: path.slice(0, slash) || '/', name: path.slice(slash + 1),
    commandId: crypto.randomUUID() }, { onSuccess: onRecreated })
  return <>
    <Button size="sm" variant="ghost" disabled={create.isPending} onClick={recreate}
      title={create.isError ? errorMessage(create.error, 'The folder could not be recreated.') : `Create an empty folder at ${path}`}>
      {create.isPending ? 'Recreating…' : 'Recreate folder'}
    </Button>
    <Link className="n-button n-button--ghost n-button--sm" to="/workspaces/$workspaceId/settings/location" params={{ workspaceId }}>
      Choose another folder
    </Link>
    {create.isError ? <span role="alert">{errorMessage(create.error, 'The folder could not be recreated.')}</span> : null}
  </>
}
