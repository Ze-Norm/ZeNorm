import { AgentEffort } from "@zenorm/contracts";

// Fails `no-restricted-syntax`: a Zod `.default(` (spec D6).
export const Effort = AgentEffort.default("medium");
