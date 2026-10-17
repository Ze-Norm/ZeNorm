import { changeFeed } from "@zenorm/db";

// Fails `no-restricted-imports`: the change feed is never read to decide.
export const table = changeFeed;
