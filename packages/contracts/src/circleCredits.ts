import { z } from 'zod'

/**
 * CircleCI's Free plan grants 30,000 credits per month for personal (non-open-source) usage and refills them at
 * the start of the next month: https://circleci.com/docs/guides/plans-pricing/credits/
 */
export const CIRCLE_FREE_PLAN_MONTHLY_CREDITS = 30_000

/** An estimate: the account's monthly allowance minus the credits CircleCI's usage export reports for this month. */
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

/** Spread into a CircleCI account's readback; `credits` is null with a short reason when the usage could not be read. */
export const circleCreditsShape = {
  credits: CircleCreditsSchema.nullable().optional(),
  creditsUnavailable: z.string().max(300).optional(),
}
