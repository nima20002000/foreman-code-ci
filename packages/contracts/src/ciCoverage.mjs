/** @typedef {{ version: 1, commit: string, testFiles: string[], coverage: Record<string, string[]>, staticTests?: string[] }} IntegrationCoverage */
const integrationFile = /^apps\/api\/test\/[^/]+\.integration\.test\.ts$/
const relativeFile = /^(?!\/|[A-Za-z]:)[^\\\0]+$/
const repositoryFile = file => typeof file === 'string' && relativeFile.test(file)
  && file.split('/').every(part => part && part !== '.' && part !== '..')

/** Reports may be fragments; only a map covering its complete inventory can narrow selection. */
/** @param {unknown} value @returns {value is IntegrationCoverage} */
export function isIntegrationCoverage(value) {
  return value !== null && typeof value === 'object' && value.version === 1
    && typeof value.commit === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.commit)
    && Array.isArray(value.testFiles) && value.testFiles.length > 0
    && value.testFiles.every(file => repositoryFile(file) && integrationFile.test(file))
    && new Set(value.testFiles).size === value.testFiles.length
    && value.coverage !== null && typeof value.coverage === 'object' && !Array.isArray(value.coverage)
    && Object.entries(value.coverage).every(([file, paths]) => value.testFiles.includes(file)
      && Array.isArray(paths) && paths.every(repositoryFile))
    && (value.staticTests === undefined || Array.isArray(value.staticTests)
      && value.staticTests.every(file => value.testFiles.includes(file)))
}

/** @param {unknown} value @returns {value is IntegrationCoverage} */
export function completeIntegrationCoverage(value) {
  return isIntegrationCoverage(value) && value.testFiles.every(file => Object.hasOwn(value.coverage, file))
}
