const ACCOUNT_BINDING_OWNERS = ['run-node', 'operator-command', 'agent-conversation']

/** Answers the two reads the worker conversation modules make beside the conversation row, by what each binds: the
 * live management principal read binds one principal id, the accepted provider account read binds an owner kind and
 * an owner id. Returns undefined for every other read so the caller can answer it. */
export function workerConversationStoreRead(values: readonly unknown[] | undefined,
  known: { principals: readonly object[]; accountBinding: unknown }): { rows: unknown[] } | undefined {
  if (values?.length === 1) {
    const principal = known.principals.find(row => (row as { id?: unknown }).id === values[0])
    if (principal) return { rows: [principal] }
  }
  if (values?.length === 2 && ACCOUNT_BINDING_OWNERS.includes(values[0] as string)) {
    return { rows: [{ binding: known.accountBinding }] }
  }
  return undefined
}
