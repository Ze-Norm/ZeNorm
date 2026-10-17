import type { AccessDeniedError } from "@zenorm/contracts";

/** The sentence for `access_denied`: the access check refused the project. */
export function accessDeniedSentence(error: AccessDeniedError): string {
  return `You do not have access to project ${error.data.projectId}.`;
}
