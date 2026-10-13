import { join } from 'node:path'

export function slotSource(root: string, slotIndex: number): string {
  return join(root, 'cache', 'slots', String(slotIndex), 'src')
}

export function checkoutCommands(commit: string): string[][] {
  return [
    ['checkout', '--quiet', '--force', '--detach', commit],
    ['clean', '-ffdx', '-e', 'node_modules', '-e', 'node_modules/'],
  ]
}
