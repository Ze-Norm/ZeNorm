/** A stored value the caller knows is set; null is a programmer error. */
export function present<T>(value: T | null, what: string): T {
  if (value === null) {
    throw new Error(`${what} is not set`);
  }
  return value;
}
