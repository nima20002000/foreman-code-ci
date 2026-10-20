import type pg from 'pg'
import { withExclusiveGraphConnection } from '../run-graph/connection.js'
import { MemoryBoardService } from './service.js'
import type { MemoryBoardAuthority, MemoryBoardDependencies } from './types.js'

/** Each visible board owns a listener. Closed boards keep no connection or timer.
 * LISTEN finishes before HTTP opens the stream, so the subsequent snapshot is safe. */
export function postgresMemoryBoardListener(pool: pg.Pool): MemoryBoardDependencies['listen'] {
  return async (boardId,changed,disconnected) => {
    const client = await pool.connect()
    let closed = false
    const notification = (message: pg.Notification) => {
      if (!closed && message.channel==='memory_board_changes' && message.payload===boardId) changed()
    }
    const lost = () => { if (!closed) { closed=true; client.release(true); disconnected() } }
    client.on('notification',notification)
    client.on('error',lost)
    client.on('end',lost)
    try { await client.query('listen memory_board_changes') }
    catch (error) {
      if (!closed) { closed=true;client.release(true) }
      client.removeListener('notification',notification);client.removeListener('error',lost);client.removeListener('end',lost)
      throw error
    }
    return () => {
      if (closed) return
      closed=true
      client.removeListener('notification',notification)
      client.removeListener('error',lost);client.removeListener('end',lost)
      void client.query('unlisten memory_board_changes').then(() => client.release(),() => client.release(true))
    }
  }
}
export function createMemoryBoardService(pool: pg.Pool, authority: MemoryBoardAuthority): MemoryBoardService {
  return new MemoryBoardService({ authority,
    transaction: work => withExclusiveGraphConnection(pool,connection => connection.transaction(work)),
    readTransaction: work => withExclusiveGraphConnection(pool,connection => connection.transaction(work,true)),
    listen:postgresMemoryBoardListener(pool),
  })
}
