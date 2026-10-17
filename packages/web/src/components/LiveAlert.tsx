import { useEffect } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { useLiveUpdatesStopped } from "@/lib/live";

/** The class on `html` that gives `--live-alert` the band's height (`index.css`). */
const STOPPED_CLASS = "live-updates-stopped";

/**
 * The recorded demo deviation D14 (S9-16): while the change stream is down, a band under the top
 * bar in the demo's `work` tone for a passing state. It is part of the sticky chrome: it sticks
 * under the bar at `--live-alert` high, which it sets on `html` while shown, so the stage rail and
 * the workspace column, whose offsets count it, move down with it instead of under it.
 */
export function LiveAlert() {
  const stopped = useLiveUpdatesStopped();
  useEffect(() => {
    if (!stopped) {
      return;
    }
    document.documentElement.classList.add(STOPPED_CLASS);
    return () => {
      document.documentElement.classList.remove(STOPPED_CLASS);
    };
  }, [stopped]);
  if (!stopped) {
    return null;
  }
  return (
    <Alert
      variant="work"
      className="sticky top-(--top-bar) z-30 flex h-(--live-alert) items-center rounded-none border-x-0 border-t-0 py-0"
    >
      <AlertDescription>Live updates stopped. Reconnecting…</AlertDescription>
    </Alert>
  );
}
