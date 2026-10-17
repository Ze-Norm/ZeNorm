export function nameOf(name: string | undefined): string {
  // Fails `@eslint-community/eslint-comments/require-description`: no `-- reason` (spec D6).
  // eslint-disable-next-line no-restricted-syntax
  return name ?? "unnamed";
}
