export function nameOf(name: string | undefined): string {
  // Fails `@eslint-community/eslint-comments/require-description`: no `-- reason`.
  // eslint-disable-next-line no-restricted-syntax
  return name ?? "unnamed";
}
