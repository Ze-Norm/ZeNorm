import { isDefinedError, type ORPCError } from "@orpc/client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/** The contract-defined errors in `E`: the type `isDefinedError` narrows to. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- must equal isDefinedError's own predicate type
type DefinedError<E> = Extract<E, ORPCError<any, any>>;

/**
 * A procedure's refusal: a defined error shows its code and the caller's sentence for that code
 * (plus the server's message when `showMessage`); any other error shows `title` and its message.
 * Styled as the demo's refusal: the code as the title, in the `bad` tone.
 */
export function RefusalAlert<E extends Error>({
  error,
  sentence,
  title,
  showMessage,
}: {
  error: E;
  sentence: (error: DefinedError<E>) => string;
  title: string;
  showMessage: boolean;
}) {
  if (!isDefinedError(error)) {
    return (
      <Alert variant="destructive">
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="bad">
      <AlertTitle className="font-mono text-[11px] tracking-wide">{error.code}</AlertTitle>
      <AlertDescription>
        {showMessage ? (
          <>
            <p>{sentence(error)}</p>
            <p className="font-mono text-xs whitespace-pre-wrap">{error.message}</p>
          </>
        ) : (
          sentence(error)
        )}
      </AlertDescription>
    </Alert>
  );
}
