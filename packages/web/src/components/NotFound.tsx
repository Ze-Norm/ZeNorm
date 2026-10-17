import { useLocation } from "@tanstack/react-router";

import { RouteErrorPage } from "@/components/RouteError";

/**
 * The root route's not-found page: an address no route matches, in the same frame as a
 * route error so the top bar stays and the inbox is one click away.
 */
export function NotFound() {
  const { pathname } = useLocation();
  return (
    <RouteErrorPage
      view={{
        title: "There is no page at this address",
        sentence:
          "ZeNorm has no page here. The inbox lists every map and the project switcher every project.",
        detail: pathname,
        links: [{ label: "Back to the inbox", to: "inbox" }],
      }}
    />
  );
}
