/** Copy an object's enumerable properties except the explicitly named fields. */
export function omitProperties<T extends object, K extends keyof T & string>(value: T, properties: readonly K[]): Omit<T, K> {
  const omitted = new Set<string>(properties)
  return Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.has(key))) as Omit<T, K>
}
