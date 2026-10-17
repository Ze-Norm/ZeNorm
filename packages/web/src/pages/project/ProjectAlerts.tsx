import type { Project } from "@zenorm/contracts";
import { FolderX } from "lucide-react";

import { BlockerCard } from "@/components/NextActionCard";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/** The folder-missing alert, in the `bad` tone. */
export function FolderMissingAlert({ project }: { project: Project }) {
  return (
    <Alert variant="bad">
      <FolderX />
      <AlertTitle>Folder missing</AlertTitle>
      <AlertDescription>
        Nothing is at {project.folderPath}. New map and Start delivery need the folder and stay
        unavailable until it is back.
      </AlertDescription>
    </Alert>
  );
}

/**
 * "Start delivery is unavailable", listing the project's blockers as the one blocker card every
 * map's Delivery stage shows for them, with **Set required checks** to Project settings while
 * checks are missing. It never lists `delivery_in_progress`, which ends on its own, so it renders
 * nothing when that is the only blocker. The region is named by its headline.
 */
export function DeliveryUnavailableCard({ project }: { project: Project }) {
  const blockers = project.startDeliveryBlockers.filter(
    (blocker) => blocker !== "delivery_in_progress",
  );
  if (blockers.length === 0) {
    return null;
  }
  return (
    <BlockerCard
      project={project}
      blockers={blockers}
      label="Start delivery is unavailable"
      headline="Start delivery is unavailable."
      who={null}
      tone="blocker"
    >
      {null}
    </BlockerCard>
  );
}
