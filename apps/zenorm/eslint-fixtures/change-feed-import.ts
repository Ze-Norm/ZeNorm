import { changeFeed } from "@zenorm/db";

// Fails `no-restricted-imports`: the change feed is never read to decide (S9-14).
export const table = changeFeed;
