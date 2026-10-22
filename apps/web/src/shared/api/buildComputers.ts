import { useMutation, useQueries, useQueryClient, type QueryFunctionContext } from '@tanstack/react-query'
import { BuildComputerStatusSchema, BuildComputerUpdateSchema } from '@foreman-code/contracts/build-computers'
import type { z } from 'zod'
import { sameDeviceProvisioningTarget, type DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { apiClient, ApiError } from './client'
import { useHarnessSessionEpoch } from './harnessSettings'
import { assertSession, sessionGeneration, sessionIsSwitching } from './sessionBoundary'

export const buildComputerKeys = {
  root: ['build-computers'] as const,
  computer: (target: DeviceProvisioningTarget, generation = sessionGeneration()) => ['build-computers', generation, target] as const,
}
function verifyTarget(value: import('@foreman-code/contracts/build-computers').BuildComputerStatus, target: DeviceProvisioningTarget) {
  if (!sameDeviceProvisioningTarget(value.preference.target, target)) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Build settings belong to another computer installation.' })
  }
  return value
}
export function buildComputerQuery(target: DeviceProvisioningTarget) {
  const generation = sessionGeneration()
  return { queryKey: buildComputerKeys.computer(target), enabled: !sessionIsSwitching(),
    refetchInterval: 5_000,
    queryFn: async ({ signal }: QueryFunctionContext) => {
      assertSession(generation)
      const result = await apiClient.request('/api/management/settings/build-computers/read',
        BuildComputerStatusSchema, { method: 'POST', body: { target }, signal })
      assertSession(generation)
      return verifyTarget(result, target)
    } }
}
export function useBuildComputers(targets: readonly DeviceProvisioningTarget[]) {
  useHarnessSessionEpoch()
  return useQueries({ queries: targets.map(target => buildComputerQuery(target)) })
}

/** Saves one computer's build settings against the revision it was read at; a stale revision is rejected. */
export function useUpdateBuildComputer() {
  const client = useQueryClient()
  return useMutation({ retry: false,
    mutationFn: (input: z.input<typeof BuildComputerUpdateSchema>) => apiClient.request(
      '/api/management/settings/build-computers/update', BuildComputerStatusSchema,
      { method: 'POST', body: BuildComputerUpdateSchema.parse(input) }),
    onSettled: () => client.invalidateQueries({ queryKey: buildComputerKeys.root }) })
}
