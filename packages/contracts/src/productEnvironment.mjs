import { INSTALLATION_NAMES } from './installationNames.mjs'

/** @typedef {Record<string, string | undefined>} Environment */

/** Read the frozen installation spelling directly; there is no product-name alias.
 * @param {Environment} environment
 * @param {string} suffix
 * @returns {string | undefined}
 */
export function readProductEnvironment(environment, suffix) {
  /** @type {Readonly<Record<string, string>>} */
  const names = INSTALLATION_NAMES.environment
  return environment[names[suffix]]
}

/** Merge the file and process layers without renaming their keys.
 * @param {Environment} processEnvironment
 * @param {Environment} [fileEnvironment]
 * @returns {Environment}
 */
export function resolveProductEnvironment(processEnvironment, fileEnvironment = {}) {
  return { ...fileEnvironment, ...processEnvironment }
}
