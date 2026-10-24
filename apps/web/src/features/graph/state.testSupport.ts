import { useBoardViewportStore } from './boardViewport'

export function resetBoardViewport() {
  useBoardViewportStore.setState({ views: {} })
}
