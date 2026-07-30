export const createKeyedTemplateRefSetters = <T>(
  setRef: (key: string, value: T | null) => void,
) => {
  const setters = new Map<string, (value: T | null) => void>()

  const get = (key: string) => {
    const existing = setters.get(key)
    if (existing) return existing

    const setter = (value: T | null) => setRef(key, value)
    setters.set(key, setter)
    return setter
  }

  const retain = (keys: Iterable<string>) => {
    const retained = new Set(keys)
    for (const key of setters.keys()) {
      if (!retained.has(key)) setters.delete(key)
    }
  }

  return { get, retain }
}
