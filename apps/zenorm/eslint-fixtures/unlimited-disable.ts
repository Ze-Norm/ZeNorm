export function nameOf(name: string | undefined): string {
  // Fails `@eslint-community/eslint-comments/no-unlimited-disable`: it names no rule.
  // eslint-disable-next-line -- a reason, but no rule
  return name ?? "unnamed";
}
