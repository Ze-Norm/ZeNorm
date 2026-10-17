import { AgentEffort } from "@zenorm/contracts";

// Fails `zenorm/no-zod-catch`: a Zod schema's `.catch(`.
export const Effort = AgentEffort.catch("medium");

// Passes: a Promise's `.catch`.
export const settled = Promise.resolve(1).catch((error: unknown) => {
  throw error;
});
