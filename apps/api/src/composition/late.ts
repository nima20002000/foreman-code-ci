/** A service that code built earlier needs to reach; the stage that builds it binds it once. */
export interface Late<T> {
  bind(value: T): T
  get(): T
}

export function late<T>(name: string): Late<T> {
  let current: { value: T } | undefined
  return {
    bind(value) {
      current = { value }
      return value
    },
    get() {
      if (!current) throw new Error(`${name} is used before the stage that builds it ran.`)
      return current.value
    },
  }
}
