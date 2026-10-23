import { spawnProcess } from '../../shared/process.js'
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DomainError } from '../errors.js'
import { atomicBrowserPrivateJson } from './journal.js'
import { browserProcessAlive, browserProcessBirthId } from './processIdentity.js'
import { findBrowserVirtualDisplay } from '../../../../worker/src/browserRuntimeInstall.mjs'

interface DisplayRecord { pid: number; birthId: string | null; display: string }

/**
 * One invisible Xvfb display per computer, shared by every agent browser on Linux. It starts on first use, restarts
 * when it has died, and survives an API restart the same way its browsers do (the record lets the next API adopt it).
 * Xvfb picks a free display number itself (-displayfd); its socket and lock follow the X convention under /tmp/.X11-unix.
 */
export class BrowserVirtualDisplay {
  private current: DisplayRecord | undefined
  private starting: Promise<string> | undefined
  private readonly directory: string
  constructor(stateDirectory: string) { this.directory = join(stateDirectory, 'virtual-display') }

  ensure(): Promise<string> {
    if (this.current && this.alive(this.current)) return Promise.resolve(this.current.display)
    this.starting ??= this.start().finally(() => { this.starting = undefined })
    return this.starting
  }

  async close(): Promise<void> {
    await this.starting?.catch(error => console.error('Virtual display start failed before shutdown', error))
    const record = this.current ?? await this.read()
    this.current = undefined
    if (record && this.alive(record)) process.kill(record.pid, 'SIGTERM')
    await rm(join(this.directory, 'display.json'), { force: true })
  }

  private alive(record: DisplayRecord): boolean {
    return browserProcessAlive(record.pid, record.birthId) && existsSync(`/tmp/.X11-unix/X${record.display.slice(1)}`)
  }

  private async read(): Promise<DisplayRecord | undefined> {
    try { return JSON.parse(await readFile(join(this.directory, 'display.json'), 'utf8')) as DisplayRecord } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private async start(): Promise<string> {
    const previous = await this.read()
    if (previous && this.alive(previous)) { this.current = previous; return previous.display }
    const executable = await findBrowserVirtualDisplay()
    if (!executable) throw new DomainError('BROWSER_RUNTIME_MISSING', 'Agent browsers on Linux need Xvfb. Install it with: sudo apt-get install xvfb', 503)
    const child = spawnProcess(executable, ['-displayfd', '3', '-screen', '0', '1440x900x24', '-nolisten', 'tcp'],
      { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-400) })
    const display = await new Promise<string>((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => fail(new Error('Xvfb did not report a display in time')), 10_000)
      const fail = (error: Error) => { clearTimeout(timer); child.kill('SIGTERM'); reject(error) }
      child.once('error', fail)
      child.once('exit', () => fail(new Error(`Xvfb exited while starting: ${stderr.trim()}`)))
      child.stdio[3]?.on('data', (chunk: Buffer) => {
        output += chunk.toString()
        const number = /^(\d+)\n/.exec(output)?.[1]
        if (number) { clearTimeout(timer); resolve(`:${number}`) }
      })
    }).catch(error => {
      throw new DomainError('BROWSER_RUNTIME_MISSING', 'The virtual display for agent browsers could not start.', 503, undefined, { cause: error })
    })
    const record: DisplayRecord = { pid: child.pid ?? 0, birthId: child.pid ? browserProcessBirthId(child.pid) : null, display }
    child.once('exit', () => { if (this.current === record) this.current = undefined })
    await atomicBrowserPrivateJson(this.directory, 'display.json', record)
    this.current = record
    return display
  }
}
