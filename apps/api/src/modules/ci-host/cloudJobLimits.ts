/** Reserve 25% of GitHub's configured 60-minute job and CircleCI Free's one-hour maximum for variance.
 * CircleCI plan limits: https://circleci.com/docs/reference/configuration-reference/#jobs */
export const CLOUD_GATE_JOB_BUDGET_MS = 45 * 60_000
