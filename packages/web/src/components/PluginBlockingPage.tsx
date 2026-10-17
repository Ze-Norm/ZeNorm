import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { WebPluginError } from "@/lib/plugins";

function title(error: WebPluginError): string {
  switch (error.code) {
    case "plugin_slot_unknown":
      return "A plugin renders into an unknown slot";
    case "plugin_set_mismatch":
      return "The server and this page run different plugins";
    case "plugin_list_unreadable":
      return "Could not read the server's plugins";
  }
}

/**
 * The page `createWebApp` shows in place of the app when its plugins cannot run (D16): an unknown
 * slot, or a plugin set that differs from the server's. Nothing else renders and no query runs.
 */
export function PluginBlockingPage({ error }: { error: WebPluginError }) {
  return (
    <main className="mx-auto max-w-[880px] px-6 pt-12">
      <Alert variant="destructive">
        <AlertTitle>{title(error)}</AlertTitle>
        <AlertDescription>
          <p>{error.message}</p>
          <p className="font-mono text-xs">{error.code}</p>
        </AlertDescription>
      </Alert>
    </main>
  );
}
