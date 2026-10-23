/** Captured writer-lane identity shared by local and remote native proof readers. */
export interface NativeCaptureLane {
  id: string
  token: string
  connectionGeneration: number
  providerId: string | null
}
