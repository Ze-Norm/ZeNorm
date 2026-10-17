// Fails `no-restricted-syntax`: a `||` fallback to a literal (spec D6).
export function countOf(count: number): number {
  return count || 1;
}
