import type { SourceManifest } from '@foreman-code/contracts/source-materialization'
import type { SourceGitHubReferenceSchema } from '@foreman-code/contracts/source-operations'
import type { z } from 'zod'
import { ensureClone, systemGitWorktreePorts, type GitWorktreePorts } from './gitWorktree.js'
import { SourceError } from './manifest.js'
import type { GitProcessResult } from './gitProcess.js'

/** Paired computers get code only from GitHub. Main makes sure GitHub serves an approved commit before a
 * computer needs it: an Agent's unpublished commit is pushed from Main's clone under refs/heads/foreman/ci/. */
export async function publishCommit(ports: GitWorktreePorts, repository: string, commit: string,
  signal: AbortSignal): Promise<void> {
  const clone = await ensureClone(ports, repository, signal)
  const local = await ports.git(['cat-file', '-e', `${commit}^{commit}`], { cwd: clone, signal })
  if (local.code !== 0) {
    // With no local object to satisfy negotiation, a successful fetch proves that origin serves the commit.
    const fetched = await ports.git(['fetch', '--quiet', '--no-tags', '--depth=1', '--no-write-fetch-head',
      'origin', commit], { cwd: clone, signal })
    if (fetched.code !== 0) throw githubFailure(repository, 'fetch', fetched)
    return
  }
  // Main's clone is shallow, so local ancestry cannot prove what origin serves. A branch tip is served; any other held
  // commit (an Agent's own, or a Run's start) is pinned under foreman/ci/, transferring nothing origin already has.
  const tips = await ports.git(['ls-remote', '--heads', 'origin'], { cwd: clone, signal })
  if (tips.code !== 0) throw githubFailure(repository, 'ls-remote', tips)
  if (tips.stdout.split('\n').some(line => line.split('\t')[0] === commit)) return
  const pushed = await ports.git(['push', '--quiet', 'origin', `${commit}:refs/heads/foreman/ci/${commit}`], { cwd: clone, signal })
  if (pushed.code !== 0) {
    throw githubFailure(repository, 'push', pushed)
  }
}

function githubFailure(repository: string, operation: string, result: GitProcessResult): SourceError {
  const diagnostic = result.stderr.trim().slice(0, 4096)
  const authentication = /fatal: Authentication failed|remote: Invalid username or (?:password|token)|could not read (?:Username|Password) for /iu
  const action = operation === 'push' ? `publish to ${repository} on GitHub` : `read ${repository} from GitHub`
  return new SourceError('SOURCE_GITHUB_PUSH_REQUIRED', `Main could not ${action}. `
    + `git ${operation} failed (exit ${result.code}): ${diagnostic || 'No stderr.'}`
    + (authentication.test(result.stderr) ? ' Connect GitHub with push access on Main (gh auth login), then retry.' : ''))
}

export class GitHubSourcePublisher {
  constructor(private readonly git: GitWorktreePorts = systemGitWorktreePorts()) {}

  async publish(manifest: SourceManifest, signal: AbortSignal): Promise<z.infer<typeof SourceGitHubReferenceSchema>> {
    const repository = manifest.git?.repository, commit = manifest.git?.commit
    if (!repository || !commit || manifest.capturePolicy !== 'git-tree-v1') {
      throw new SourceError('SOURCE_REPOSITORY_REQUIRED', 'Paired computers get source only from GitHub. '
        + 'Set the workspace GitHub repository (workspace_update), then retry.')
    }
    await publishCommit(this.git, repository, commit, signal)
    return { repository, commit, executablePolicy: manifest.executablePolicy }
  }
}
