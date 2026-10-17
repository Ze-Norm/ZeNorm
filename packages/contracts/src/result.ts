/** An expected outcome: success with a value, or a failure with a coded error. */
export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

/** A failure identified by a stable code. Tests assert the code, never the message. */
export interface CodedError<C extends string> {
  readonly code: C;
  readonly message: string;
}

export function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value };
}

export function err<E>(error: E): { readonly ok: false; readonly error: E } {
  return { ok: false, error };
}
