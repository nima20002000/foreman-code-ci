import { Button } from '../../shared/ui/nocturne'
import { askOperator } from '../operator-chat/operatorChatStore'

/** Human-only step: the protected CI runtime on Main is installed locally; the Operator captures and qualifies it after. */
export function MainRuntimeSetup() {
  return <Button size="sm" variant="ghost" onClick={() => askOperator('Check the Main PC build runtime. If it is installed, capture it for the saved profile and run qualification; reconcile any qualification that needs recovery first.')}>Check build runtime</Button>
}
