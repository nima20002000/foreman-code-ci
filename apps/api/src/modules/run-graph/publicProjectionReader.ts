import type { PublicGraphProjection, RunGraphScope } from '@foreman-code/contracts/current'
import type { SqlTransaction } from '../../infrastructure/transaction.js'

export interface PublicProjectionReader {
  (sql: SqlTransaction, scope: RunGraphScope): Promise<PublicGraphProjection>
}
