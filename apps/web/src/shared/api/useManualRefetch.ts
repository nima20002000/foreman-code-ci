import { useCallback, useState } from 'react'

/** Pending state for a user-clicked refetch only, so background polling never toggles the UI. */
export function useManualRefetch(refetch: () => unknown) {
  const [pending, setPending] = useState(false)
  const run = useCallback(() => {
    setPending(true)
    return Promise.resolve(refetch()).finally(() => setPending(false))
  }, [refetch])
  return { pending, refetch: run }
}
