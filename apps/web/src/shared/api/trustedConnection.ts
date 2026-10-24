import { useQuery } from '@tanstack/react-query'
import type { DeviceRegistration } from '@foreman-code/contracts/device-identity'
import { TrustedConnectionCheckSchema } from '@foreman-code/contracts/trusted-device-connection'
import { apiClient } from './client'
import { useHarnessSessionEpoch } from './harnessSettings'
import { assertSession, sessionIsSwitching } from './sessionBoundary'

export function useTrustedConnection(registration: DeviceRegistration) {
  const generation = useHarnessSessionEpoch()
  return useQuery({ queryKey: ['trusted-connection', generation, registration.mainId, registration.deviceId,
    registration.keyRevision, registration.authorizationRevision], enabled: !sessionIsSwitching(), refetchInterval: 10_000,
    queryFn: async ({ signal }) => {
      const result = await apiClient.request('/api/devices/connection-check', TrustedConnectionCheckSchema,
        { method: 'POST', body: { deviceId: registration.deviceId }, signal })
      assertSession(generation)
      if (result.registration.deviceId !== registration.deviceId || result.registration.mainId !== registration.mainId) {
        throw new Error('Connection status belongs to another computer.')
      }
      return result
    } })
}
