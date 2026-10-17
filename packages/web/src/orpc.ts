import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient } from "@tanstack/react-query";
import type { Contract } from "@zenorm/contracts";

import { retryQuery } from "@/lib/query-errors";

const link = new RPCLink({ url: new URL("/rpc", window.location.origin).toString() });

export const client: ContractRouterClient<Contract> = createORPCClient(link);

export const orpc = createTanstackQueryUtils(client);

/** A contract-defined error is never retried, so a route error shows at once. */
export const queryClient = new QueryClient({ defaultOptions: { queries: { retry: retryQuery } } });
