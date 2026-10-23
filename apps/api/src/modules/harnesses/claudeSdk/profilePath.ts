import { homedir } from 'node:os'
import { join } from 'node:path'
import { hostEnvironment } from '../../../shared/process.js'

// Kept free of server-only imports: the installed Worker bundle uses it.
export const detectedClaudeProfilePath = () => hostEnvironment().CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
