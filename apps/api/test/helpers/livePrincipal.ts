import type { ManagementPrincipal } from '@foreman-code/contracts/management'

type Rows = { rows: unknown[]; rowCount?: number }

/** The row a live management-authority read returns for a principal. */
export function livePrincipalRow(principal: ManagementPrincipal,
  state: { revoked?: boolean; delegatedFrom?: string | null } = {}) {
  return { id: principal.id, name: principal.name, audience: principal.audience, grants: principal.grants,
    expires_at: new Date(principal.expiresAt), revoked_at: state.revoked ? new Date() : null,
    delegated_from: state.delegatedFrom ?? null }
}

/** A fake connection query that answers the live authority read of a known principal. The read is recognised by its
 * only bound value, the principal id, not by SQL text; every other statement goes to `otherwise`. */
export function liveAuthorityQuery(
  principalRow: (id: string) => ReturnType<typeof livePrincipalRow> | undefined,
  otherwise: (text: string, values: unknown[]) => Promise<Rows> | Rows = () => ({ rows: [] }),
) {
  return async (text: string, values: unknown[] = []): Promise<Rows> => {
    const row = values.length === 1 && typeof values[0] === 'string' ? principalRow(values[0]) : undefined
    return row ? { rows: [row], rowCount: 1 } : otherwise(text, values)
  }
}
