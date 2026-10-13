import { z } from 'zod'

export const CiFullScopePermissionSchema = z.boolean().optional().describe(
  'Explicit permission for this Agent to use jobs:ci_full. Omitted or false permits affected CI only; '
  + 'the Run owner must also hold jobs:ci_full. Configure per Agent, never through global defaults.',
)
