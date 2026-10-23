export const CI_TEST_RESULT_LIMITS: {
  readonly tests: number; readonly files: number; readonly name: number; readonly file: number
  readonly message: number; readonly location: number
}
export type CiTestStatus = 'passed' | 'failed' | 'skipped'
export interface CiTestResults {
  summary: Record<CiTestStatus, number>
  truncated: boolean
  files: { file: string; status: CiTestStatus; durationMs: number | null
    tests: { name: string; status: CiTestStatus; durationMs: number | null; message?: string; location?: string }[] }[]
}
/** Merges Vitest JSON reports into the bounded results a CI ticket keeps; paths are relative to `repository`. */
export function ciTestResults(reports: readonly unknown[], repository: string): CiTestResults
