import { DomainError } from '../errors.js'
import { ExecutionLimiter } from '../runs/limiter.js'

/** One execution limiter per Run, pinned to the parallelism the Run started with. */
export class RunExecutionCapacity {
  private readonly runs = new Map<string, { maximum: number; limiter: ExecutionLimiter }>()

  limiter(runId: string, maximum: number): ExecutionLimiter {
    const existing = this.runs.get(runId)
    if (existing) {
      if (existing.maximum !== maximum) throw new DomainError('RUN_PIN_CONFLICT', 'Run parallelism changed.', 409)
      return existing.limiter
    }
    const limiter = new ExecutionLimiter(maximum, 1000)
    this.runs.set(runId, { maximum, limiter })
    return limiter
  }

  release(runId: string): void { this.runs.delete(runId) }
}
