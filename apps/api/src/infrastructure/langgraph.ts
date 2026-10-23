import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'

/*
 * The one module that touches LangGraph. Everything the product needs from it is re-exported here, so the pinned
 * dependency contract below lives in one place instead of in every graph module.
 *
 * Contract (pinned in package.json; pnpm refuses to install a different version of a patched package):
 *  - @langchain/langgraph 1.4.15 carries patches/@langchain__langgraph@1.4.15.patch. It observes a failed
 *    background checkpoint write the moment it happens (dist/pregel/loop.{js,cjs}) so Node never reports it as an
 *    unhandled rejection before the persistence barrier awaits it. Remove the patch only with a LangGraph version
 *    that observes those promises itself, then drop this note.
 *  - @langchain/langgraph-checkpoint-postgres 1.0.5 exposes the protected `_dump*` serializers the product's
 *    savers reuse. Only `LangGraphPostgresSaver` below calls them.
 */
export { Annotation, Command, END, interrupt, isGraphInterrupt, Send, START, StateGraph } from '@langchain/langgraph'
export { WRITES_IDX_MAP } from '@langchain/langgraph-checkpoint'
export type { BaseCheckpointSaver, SerializerProtocol } from '@langchain/langgraph-checkpoint'

type PutParameters = Parameters<PostgresSaver['put']>
type PutWritesParameters = Parameters<PostgresSaver['putWrites']>

/**
 * The PostgresSaver the product's savers extend. It is the only class that reads PostgresSaver's protected
 * serialization helpers; subclasses call the `dump*` forwards, so a LangGraph upgrade changes this class alone.
 */
export abstract class LangGraphPostgresSaver extends PostgresSaver {
  protected dumpBlobs(threadId: string, namespace: string, channelValues: PutParameters[1]['channel_values'],
    versions: PutParameters[3]) {
    return this._dumpBlobs(threadId, namespace, channelValues, versions)
  }

  protected dumpMetadata(metadata: PutParameters[2]) {
    return this._dumpMetadata(metadata)
  }

  protected dumpCheckpoint(checkpoint: PutParameters[1]) {
    return this._dumpCheckpoint(checkpoint)
  }

  protected dumpWrites(threadId: string, namespace: string, checkpointId: string, taskId: string,
    writes: PutWritesParameters[1]) {
    return this._dumpWrites(threadId, namespace, checkpointId, taskId, writes)
  }
}
