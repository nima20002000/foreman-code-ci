import { z } from 'zod'

/**
 * CircleCI's Free plan grants each organization 400,000 credits per month for Linux open-source builds and refills
 * them at the start of the next month; CircleCI exposes no API for this balance:
 * https://circleci.com/docs/guides/plans-pricing/credits/
 */
export const CIRCLE_OPEN_SOURCE_MONTHLY_CREDITS = 400_000

/** An estimate: the organization's monthly allowance minus the credits CircleCI's usage export reports for this month. */
export const CircleCreditsSchema = z.object({
  /** The configured monthly allowance. */
  total: z.number().nonnegative(),
  /** Credits used this calendar month (UTC) according to CircleCI's usage export. */
  used: z.number().nonnegative(),
  remaining: z.number().nonnegative(),
  /** When the usage was read from CircleCI. */
  asOf: z.string().datetime(),
}).strict()
export type CircleCredits = z.infer<typeof CircleCreditsSchema>

/** One organization of the CircleCI login: its credits, or null with a short reason when its usage could not be read. */
export const CircleOrgCreditsSchema = z.object({
  /** The GitHub owner of the organization. */
  org: z.string().min(1),
  credits: CircleCreditsSchema.nullable(),
  unavailable: z.string().max(300).optional(),
}).strict()
export type CircleOrgCredits = z.infer<typeof CircleOrgCreditsSchema>

/** Every organization of the CircleCI login plus the sum over the organizations whose usage could be read. */
export const CircleAccountCreditsSchema = z.object({
  orgs: z.array(CircleOrgCreditsSchema).max(64),
  /** Null when no organization could be read; organizations without a reading are not part of the sum. */
  total: CircleCreditsSchema.nullable(),
}).strict()
export type CircleAccountCredits = z.infer<typeof CircleAccountCreditsSchema>

/** Spread into a CircleCI account's readback; `credits` is null with a short reason when no organization could be listed. */
export const circleCreditsShape = {
  credits: CircleAccountCreditsSchema.nullable().optional(),
  creditsUnavailable: z.string().max(300).optional(),
}
