import "@fontsource-variable/instrument-sans";
import "@fontsource-variable/space-grotesk";
import "@fontsource-variable/jetbrains-mono";
import "./index.css";

import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import type { WebPlugin } from "@zenorm/plugin-sdk";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { PluginBlockingPage } from "@/components/PluginBlockingPage";
import { WebPluginsContext } from "@/components/PluginSlot";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorkspaceSheetProvider } from "@/components/WorkspaceColumns";
import { LiveUpdatesContext, startLiveUpdates } from "@/lib/live";
import type { LiveUpdates } from "@/lib/live";
import { checkWebPlugins } from "@/lib/plugins";
import { startBrowserTheme, ThemeContext } from "@/lib/theme";
import { queryClient } from "@/orpc";
import { router } from "@/router";

/** What a composing app passes: its web plugins, in the same order as the server's. */
export interface WebAppOptions {
  readonly plugins: readonly WebPlugin[];
}

/**
 * The web app, composed in code (S9-18): `apps/zenorm` passes no plugins, an example or paid
 * composition passes its own. It mounts on `#root` once the plugins pass D16's checks (slot names,
 * then `GET /plugins` against this list); otherwise it shows the blocking page and starts nothing.
 * Returns the unmount: what it rendered is unmounted, and a check still pending renders nothing.
 */
export function createWebApp({ plugins }: WebAppOptions): () => void {
  const rootElement = document.getElementById("root");
  if (rootElement === null) {
    throw new Error("index.html has no #root element");
  }
  const root = createRoot(rootElement);
  // The person's colour scheme (`lib/theme.ts`): index.html's head script set the first paint's;
  // this one owns it from here, following the system until a choice is made.
  const theme = startBrowserTheme();
  let unmounted = false;
  let live: LiveUpdates | null = null;

  void checkWebPlugins(plugins, () =>
    fetch(new URL("/plugins", window.location.origin).toString()),
  ).then((checked) => {
    if (unmounted) return;
    if (!checked.ok) {
      root.render(
        <StrictMode>
          <ThemeContext value={theme}>
            <PluginBlockingPage error={checked.error} />
          </ThemeContext>
        </StrictMode>,
      );
      return;
    }

    // The app's one change stream (S9-16, D13), opened once outside React so StrictMode's double
    // effects never open a second.
    live = startLiveUpdates(queryClient, () => new EventSource("/events"), {
      setTimeout: (callback, ms) => window.setTimeout(callback, ms),
      clearTimeout: (id) => {
        window.clearTimeout(id);
      },
    });

    root.render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <LiveUpdatesContext value={live}>
            <WebPluginsContext value={plugins}>
              <ThemeContext value={theme}>
                <TooltipProvider delayDuration={300}>
                  <WorkspaceSheetProvider>
                    <RouterProvider router={router} />
                  </WorkspaceSheetProvider>
                </TooltipProvider>
              </ThemeContext>
            </WebPluginsContext>
          </LiveUpdatesContext>
        </QueryClientProvider>
      </StrictMode>,
    );
  });
  return () => {
    unmounted = true;
    live?.close();
    theme.close();
    root.unmount();
  };
}
