import { AgentEffort } from "@zenorm/contracts";

// Fails `no-restricted-syntax`: a Zod `.default(`.
export const Effort = AgentEffort.default("medium");
