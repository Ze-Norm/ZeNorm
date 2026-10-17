// Fails `no-restricted-syntax`: a `||` fallback to a literal.
export function countOf(count: number): number {
  return count || 1;
}
