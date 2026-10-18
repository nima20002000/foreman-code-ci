import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const targets = {
  'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc',
}

function executable(path) {
  accessSync(path, constants.X_OK)
  const info = statSync(path)
  if (!info.isFile() || info.size === 0) throw new Error(`The required executable is empty or invalid: ${path}`)
}

/** Optional package installation can succeed while the platform's required Codex payload is absent. */
export function assertRequiredNativePayloads(root) {
  const apiManifest = join(root, 'apps/api/package.json')
  if (!existsSync(apiManifest)) return
  const api = JSON.parse(readFileSync(apiManifest, 'utf8'))
  const version = api.dependencies?.['@openai/codex']
  if (!version) return
  const platform = process.platform === 'android' ? 'linux' : process.platform
  const target = `${platform}-${process.arch}`
  const nativeName = `@openai/codex-${target}`
  try {
    if (!targets[target]) throw new Error(`Unsupported native target: ${target}`)
    const launcher = createRequire(apiManifest).resolve('@openai/codex/bin/codex.js')
    executable(launcher)
    const provider = JSON.parse(readFileSync(join(dirname(launcher), '../package.json'), 'utf8'))
    if (provider.version !== version) throw new Error('Installed Codex does not match its pinned dependency version.')
    const nativeManifest = createRequire(launcher).resolve(`${nativeName}/package.json`)
    const native = JSON.parse(readFileSync(nativeManifest, 'utf8'))
    if (provider.optionalDependencies?.[nativeName] !== `npm:${native.name}@${native.version}`) {
      throw new Error('The installed platform package does not match the pinned Codex launcher.')
    }
    executable(join(dirname(nativeManifest), 'vendor', targets[target], 'bin', platform === 'win32' ? 'codex.exe' : 'codex'))
  } catch (error) {
    throw new Error(`CI_NATIVE_PAYLOAD_UNAVAILABLE: ${nativeName}. Restore the CI pnpm store and reinstall the frozen `
      + `lockfile before retrying. ${error.message}`, { cause: error })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    assertRequiredNativePayloads(resolve(process.argv[2] ?? process.cwd()))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
