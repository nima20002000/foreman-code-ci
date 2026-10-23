import { homedir } from 'node:os'
import { join } from 'node:path'

/** Sign-in facts shared by the computer probe, the managed-account observer and the credential store. */

/** The file in a provider's home directory that holds its sign-in credentials. */
export function credentialFileName(provider: 'codex' | 'claude'): string {
  return provider === 'codex' ? 'auth.json' : '.credentials.json'
}

/** The Codex home an environment selects. */
export function codexHome(environment: NodeJS.ProcessEnv): string {
  return environment.CODEX_HOME ?? join(environment.HOME ?? homedir(), '.codex')
}

/** The Claude configuration directory an environment selects. */
export function claudeConfigDir(environment: NodeJS.ProcessEnv): string {
  return environment.CLAUDE_CONFIG_DIR ?? join(environment.HOME ?? homedir(), '.claude')
}

export interface CodexFileSignIn { signedIn: boolean; account: string | null; details: string[] }

/** Reads sign-in facts from the text of Codex's `auth.json`. Throws on unparsable text. Tokens are never returned. */
export function parseCodexAuthFile(text: string): CodexFileSignIn {
  const auth = JSON.parse(text) as { auth_mode?: unknown; OPENAI_API_KEY?: unknown; tokens?: { id_token?: unknown } | null }
  const email = typeof auth.tokens?.id_token === 'string' ? jwtEmail(auth.tokens.id_token) : null
  const apiKey = typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.length > 0
  return { signedIn: Boolean(email || auth.tokens || apiKey), account: email,
    details: [apiKey && !auth.tokens ? 'API key' : auth.tokens ? 'ChatGPT' : null].filter((value): value is string => Boolean(value)) }
}

function jwtEmail(token: string): string | null {
  const payload = token.split('.')[1]
  if (!payload) return null
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { email?: unknown }
  return typeof claims.email === 'string' ? claims.email.slice(0, 320) : null
}

export interface CommandOutput { code: number | null; stdout: string; stderr?: string }

export type CodexLoginStatus = 'signed-in' | 'signed-out' | 'unknown'

/** Classifies the output of `codex login status`. */
export function parseCodexLoginStatus(result: Pick<CommandOutput, 'code' | 'stdout'>): CodexLoginStatus {
  if (result.code === 0 && /logged in using chatgpt/i.test(result.stdout)) return 'signed-in'
  if (/^\s*not logged in\s*$/i.test(result.stdout)) return 'signed-out'
  return 'unknown'
}

export type ClaudeAuthStatus =
  /** Output that is not JSON. `signedOutNotice` is set for the login prompt signed-out releases print. */
  | { kind: 'unreadable'; signedOutNotice: boolean }
  /** JSON that is not an object with a boolean `loggedIn`. */
  | { kind: 'malformed' }
  | { kind: 'status'; loggedIn: boolean; fields: Record<string, unknown> }

/** Parses the output of `claude auth status`. Callers decide what the exit code means for their purpose. */
export function parseClaudeAuthStatus(result: CommandOutput): ClaudeAuthStatus {
  let parsed: unknown
  try { parsed = JSON.parse(result.stdout) } catch {
    return { kind: 'unreadable', signedOutNotice: result.code !== 0
      && /\/login|not logged in|invalid api key/iu.test(`${result.stdout}\n${result.stderr ?? ''}`) }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'malformed' }
  const fields = parsed as Record<string, unknown>
  if (typeof fields.loggedIn !== 'boolean') return { kind: 'malformed' }
  return { kind: 'status', loggedIn: fields.loggedIn, fields }
}
