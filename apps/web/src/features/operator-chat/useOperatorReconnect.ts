import { useEffect, useRef, useState } from 'react'

const retryMs = 3_000
const downAfterMs = 30_000

/** While reads fail (e.g. the API restarts), retry quietly; report `down` only after ~30 s. */
export function useOperatorReconnect(failing: boolean, retry: () => void): 'reconnecting' | 'down' | undefined {
  const [down, setDown] = useState(false)
  const retryRef = useRef(retry)
  retryRef.current = retry
  useEffect(() => {
    if (!failing) { setDown(false); return }
    const timer = window.setInterval(() => retryRef.current(), retryMs)
    const downTimer = window.setTimeout(() => setDown(true), downAfterMs)
    return () => { window.clearInterval(timer); window.clearTimeout(downTimer) }
  }, [failing])
  return failing ? down ? 'down' : 'reconnecting' : undefined
}
