// Fails `no-restricted-syntax`: a `??` fallback to each literal kind (spec D6).
export function fallbacks(value: string | number | boolean | null | undefined) {
  return [
    value ?? "unnamed",
    value ?? 0,
    value ?? false,
    value ?? null,
    value ?? `unnamed`,
    value ?? [],
    value ?? {},
  ];
}
