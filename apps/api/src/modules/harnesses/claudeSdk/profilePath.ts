import { homedir } from 'node:os'
import { join } from 'node:path'

export const detectedClaudeProfilePath = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
