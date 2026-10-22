import { ManagementActionSchema, ManagementPrincipalSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import type pg from 'pg'
import type { PostgresAccessService } from './postgres.js'

export const localHumanPrincipal = ManagementPrincipalSchema.parse({
  id: 'principal-local-human',
  name: 'Local human',
  audience: 'operator',
  grants: [{ actions: [...ManagementActionSchema.options], scope: {} }],
  expiresAt: '9999-12-31T23:59:59.000Z',
  revokedAt: null,
})

export interface LocalHumanAccess {
  current(): Promise<ManagementPrincipal>
}

export class PostgresLocalHumanAccess implements LocalHumanAccess {
  constructor(private readonly pool: pg.Pool, private readonly access: PostgresAccessService) {}

  async current(): Promise<ManagementPrincipal> {
    const result = await this.pool.query<{ principal_id: string }>(
      'select principal_id from local_human_principal where singleton = true',
    )
    const id = result.rows[0]?.principal_id
    if (!id) throw new Error('The implicit local human principal has not been migrated.')
    const principal = await this.access.currentOperator(id)
    if (holdsEveryAction(principal)) return principal
    // The stored grant lists the actions that existed when it was written. The local human may do everything,
    // so an action added later is granted here instead of failing as ACCESS_DENIED.
    await this.pool.query('update management_principals set grants=$2::jsonb where id=$1', [id, JSON.stringify(localHumanPrincipal.grants)])
    return this.access.currentOperator(id)
  }
}

function holdsEveryAction(principal: ManagementPrincipal): boolean {
  return ManagementActionSchema.options.every(action => principal.grants.some(grant =>
    grant.actions.includes(action) && Object.values(grant.scope).every(ids => !ids)))
}
