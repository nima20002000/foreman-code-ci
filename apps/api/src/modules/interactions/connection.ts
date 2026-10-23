import { AsyncLocalStorage } from 'node:async_hooks'
import type pg from 'pg'

/**
 * The one ambient database client left in the API. Native delivery already holds the Stop transaction when it calls
 * the harness to deliver a response (PostgresInteractionDeliveryRepository.deliver), and lane fencing, continuation
 * and graph-authority checks reached from that harness callback must use that connection rather than wait for another
 * slot in the same pool. The client is not passed explicitly because the callback crosses the harness delivery ports;
 * every read goes through the two functions below.
 */
const deliveryTransaction = new AsyncLocalStorage<pg.PoolClient>()

/** Runs a native delivery callback inside the delivery transaction held on `client`. */
export function runInDeliveryTransaction<T>(client: pg.PoolClient, work: () => Promise<T>): Promise<T> {
  return deliveryTransaction.run(client, work)
}

/** The open native delivery transaction when called from inside one. */
export function deliveryTransactionClient(): pg.PoolClient | undefined {
  return deliveryTransaction.getStore()
}
