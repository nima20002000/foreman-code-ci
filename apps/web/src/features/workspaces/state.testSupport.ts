import { useNavigationUiStore } from './navigationUiStore'

export function resetNavigationUi() {
  useNavigationUiStore.getState().reset()
}
