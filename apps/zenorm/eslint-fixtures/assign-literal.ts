// Fails `no-restricted-syntax`: a `??=` or `||=` fallback to a literal, `[]` or `{}`.
export function assigned(options: {
  name?: string;
  label?: string;
  tags?: string[];
  extra?: Record<string, number>;
}): unknown[] {
  options.name ??= "unnamed";
  options.label ||= `unlabelled`;
  options.tags ??= [];
  options.extra ??= {};
  return [options.name, options.label, options.tags, options.extra];
}
