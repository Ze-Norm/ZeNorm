import type { AccessDeniedError } from "@zenorm/contracts";

/** The sentence for `access_denied` (S9-17): the access check refused the project. */
export function accessDeniedSentence(error: AccessDeniedError): string {
  return `You do not have access to project ${error.data.projectId}.`;
}
