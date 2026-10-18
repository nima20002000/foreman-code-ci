export interface IntegrationCoverage {
  version: 1
  commit: string
  testFiles: string[]
  coverage: Record<string, string[]>
  staticTests?: string[]
}
export function isIntegrationCoverage(value: unknown): value is IntegrationCoverage
export function completeIntegrationCoverage(value: unknown): value is IntegrationCoverage
