import { isDefinedError } from "@orpc/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { AccessDeniedError, DeleteMapError, MapRecord } from "@zenorm/contracts";
import { Trash2 } from "lucide-react";
import { useState } from "react";

import { RefusalAlert } from "@/components/RefusalAlert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { accessDeniedSentence } from "@/lib/access";
import { mapName } from "@/lib/map";
import { orpc } from "@/orpc";

/** The sentence shown for a `map.delete` refusal, chosen by its code. */
function deleteRefusalMessage(error: DeleteMapError | AccessDeniedError): string {
  switch (error.code) {
    case "access_denied":
      return accessDeniedSentence(error);
    case "map_not_found":
      return "This map no longer exists.";
    case "map_wrote_spec":
      return `This map wrote ${specsLabel(error.data.specs)}. Specs belong to the project, so deleting the map deletes ${error.data.specs.length === 1 ? "it" : "them"} too, with ${error.data.specs.length === 1 ? "its" : "their"} ticket sets and unmerged delivery runs and their branches. Another map's link to ${error.data.specs.length === 1 ? "it" : "them"} is left as text.`;
    case "map_spec_shared":
      return `Another map also worked on spec ${String(error.data.spec)}, so it cannot be deleted with this map.`;
    case "map_spec_delivered":
      return deliveredSentence(error.data.spec, error.data.reason);
    case "map_run_in_flight":
      return "The agent is working on this map. Delete it once the run has ended.";
    case "map_split_linked":
      return "This map was split from another map, or another map from it, so it cannot be deleted.";
    case "map_waited_on":
      return "Another map waits on a spec this map was revising, so it cannot be deleted.";
  }
}

type DeliveredReason = Extract<DeleteMapError, { code: "map_spec_delivered" }>["data"]["reason"];

/** Why spec `spec`'s delivery run keeps it from going with the map. */
function deliveredSentence(spec: number, reason: DeliveredReason): string {
  switch (reason) {
    case "active":
      return `Spec ${String(spec)} is being delivered. Delete the map once its run has ended.`;
    case "merged":
      return `Spec ${String(spec)}'s delivery was merged, so it cannot be deleted with this map.`;
    case "pr_open":
      return `Spec ${String(spec)}'s pull request is open. Close it on GitHub and check it, then delete the map.`;
  }
}

/** "spec 5" or "specs 2, 5". */
function specsLabel(specs: readonly number[]): string {
  return `${specs.length === 1 ? "spec" : "specs"} ${specs.join(", ")}`;
}

/**
 * **Delete map** and its confirmation: `map.delete` removes the map and everything on it, then the
 * project's page opens and the map's cached reads go, so nothing refetches the deleted map. A
 * refusal shows in the dialog, which stays open with **Delete map** disabled until it is reopened;
 * a map that wrote specs is refused first, naming them, and offers **Delete map and spec N**, which
 * deletes exactly those with it: if the map wrote another spec since, that delete is refused too,
 * naming them all, and the button offers them again.
 */
export function DeleteMapButton({ map }: { map: MapRecord }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  // The specs the map was refused for, once it was: the delete then offers to take them too.
  const [wroteSpecs, setWroteSpecs] = useState<readonly number[] | null>(null);
  const remove = useMutation(
    orpc.map.delete.mutationOptions({
      onError: (error) => {
        if (isDefinedError(error) && error.code === "map_wrote_spec") {
          setWroteSpecs(error.data.specs);
        }
      },
      onSuccess: async ({ mapId, projectId }) => {
        setOpen(false);
        await navigate({ to: "/projects/$projectId", params: { projectId } });
        queryClient.removeQueries({ queryKey: orpc.map.overview.queryKey({ input: { mapId } }) });
        queryClient.removeQueries({ queryKey: orpc.map.get.queryKey({ input: { mapId } }) });
        await Promise.all(
          [orpc.map.overviews.key(), orpc.map.list.key(), orpc.project.get.key()].map((queryKey) =>
            queryClient.invalidateQueries({ queryKey }),
          ),
        );
      },
    }),
  );
  // A refusal of the delete that takes the specs too ends it, and the button stays disabled, unless
  // the map wrote another spec since: then it offers the specs the refusal names.
  const specsRefused =
    remove.isError &&
    remove.variables.deleteSpecs.length > 0 &&
    !(isDefinedError(remove.error) && remove.error.code === "map_wrote_spec");
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          remove.reset();
          setWroteSpecs(null);
        }
        setOpen(next);
      }}
    >
      <AlertDialogTrigger asChild>
        <Button variant="outline">
          <Trash2 /> Delete map
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="border-ink-line">
        <AlertDialogHeader>
          <AlertDialogTitle className="font-display tracking-[-0.015em]">
            Delete this map?
          </AlertDialogTitle>
          <AlertDialogDescription>
            “{mapName(map)}” and everything on it go for good: its rounds and answers, waypoints,
            messages and runs. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {remove.error !== null && (
          <RefusalAlert
            error={remove.error}
            sentence={deleteRefusalMessage}
            title="Could not delete the map"
            showMessage={false}
          />
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
          {wroteSpecs === null ? (
            <Button
              variant="destructive"
              disabled={remove.isPending || remove.isError}
              onClick={() => {
                remove.mutate({ mapId: map.id, deleteSpecs: [] });
              }}
            >
              Delete map
            </Button>
          ) : (
            <Button
              variant="destructive"
              disabled={remove.isPending || specsRefused}
              onClick={() => {
                remove.mutate({ mapId: map.id, deleteSpecs: [...wroteSpecs] });
              }}
            >
              Delete map and {specsLabel(wroteSpecs)}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
