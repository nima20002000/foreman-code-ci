import type { LightMyRequestResponse } from 'fastify'

/** The caller retains the original request, including its commandId, for every attempt. */
export async function requestDatabaseCommand(
  request: () => Promise<LightMyRequestResponse>,
): Promise<LightMyRequestResponse> {
  return request()
}
