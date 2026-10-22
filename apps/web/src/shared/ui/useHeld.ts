import { useEffect, useState } from 'react'

/** True as soon as `value` is true; false only once `value` has stayed false for `holdMs`, so a status that
 * flips on every retry (e.g. while the API restarts) shows one steady notice instead of flickering. */
export function useHeld(value: boolean, holdMs = 3000): boolean {
  const [held, setHeld] = useState(value)
  useEffect(() => {
    if (value) { setHeld(true); return }
    const timer = window.setTimeout(() => setHeld(false), holdMs)
    return () => window.clearTimeout(timer)
  }, [value, holdMs])
  return value || held
}

/** True only once `value` has stayed true for `delayMs`: a failure that clears on the next retry never shows. */
export function useSustained(value: boolean, delayMs = 20_000): boolean {
  const [sustained, setSustained] = useState(false)
  useEffect(() => {
    if (!value) { setSustained(false); return }
    const timer = window.setTimeout(() => setSustained(true), delayMs)
    return () => window.clearTimeout(timer)
  }, [value, delayMs])
  return value && sustained
}
