import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type CreateMapError, type Project } from "@zenorm/contracts";
import { ArrowRight, Loader2, Plus } from "lucide-react";
import { useState } from "react";

import { AddProjectDialog } from "@/components/AddProjectDialog";
import { Micro } from "@/components/parts";
import { RefusalAlert } from "@/components/RefusalAlert";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { orpc } from "@/orpc";
import type { AccessDeniedError } from "@zenorm/contracts";
import { accessDeniedSentence } from "@/lib/access";

/**
 * The sentence shown for a `map.create` refusal, chosen by its code; a confirmed proposal's new map
 * is refused the same way (map proposals).
 */
export function createMapRefusalMessage(error: CreateMapError | AccessDeniedError): string {
  if (error.code === "access_denied") return accessDeniedSentence(error);
  switch (error.code) {
    case "project_not_found":
      return "This project no longer exists.";
    case "project_folder_missing":
      return `There is no folder at ${error.data.folderPath}; the project's repository has moved or been deleted.`;
  }
}

/**
 * The project select's value for its **Add project…** item, which opens Add project instead of
 * choosing; a project id is a UUID, so it never collides.
 */
const ADD_PROJECT = "add-project";

/** Where a new map goes: a project the person chooses (Inbox), or one fixed project (its page). */
export type ComposerTarget =
  { kind: "choose"; projects: readonly Project[] } | { kind: "fixed"; project: Project };

/**
 * The map composer: the idea, the project, and **Start map**, disabled until both are set.
 * `map.create` returns at once and the agent charts the map in the background: a refusal shows
 * its code, and success opens Idea. `disabledReason` disables it and says why.
 * `onCancel`, when given, adds Cancel beside Start map (the project page's composer, opened by
 * New map); null for the Inbox's, which is always open.
 */
export function MapComposer({
  target,
  disabledReason,
  onCancel,
}: {
  target: ComposerTarget;
  disabledReason: string | null;
  onCancel: (() => void) | null;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [idea, setIdea] = useState("");
  // The chosen project's id; "" until the person chooses one (no preselection).
  const [chosenId, setChosenId] = useState("");
  const [adding, setAdding] = useState(false);
  const projectId = target.kind === "fixed" ? target.project.id : chosenId;
  // The chosen project, for the trigger's value: its name alone, since its folder path (shown in
  // the option) runs past a phone's width and would push Start map out of the viewport.
  const chosen =
    target.kind === "choose"
      ? target.projects.find((project) => project.id === chosenId)
      : undefined;

  const create = useMutation(
    orpc.map.create.mutationOptions({
      onSuccess: async (detail) => {
        await queryClient.invalidateQueries({ queryKey: orpc.map.key() });
        await navigate({
          to: "/maps/$mapId/$stage",
          params: { mapId: detail.map.id, stage: "idea" },
        });
      },
    }),
  );

  const disabled = disabledReason !== null;
  const ready = !disabled && idea.trim() !== "" && projectId !== "" && !create.isPending;

  function start() {
    if (!ready) {
      return;
    }
    create.mutate({ projectId, idea: idea.trim() });
  }

  return (
    <div className="grid gap-3">
      <section aria-label="New map" className="border border-ink-line bg-card">
        <Textarea
          aria-label="Idea"
          value={idea}
          disabled={disabled}
          onChange={(event) => {
            setIdea(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              start();
            }
          }}
          placeholder="Describe a change you want to make…"
          className="min-h-20 resize-none rounded-none border-0 bg-transparent px-4 py-3.5 text-[15px] shadow-none focus-visible:ring-0"
        />
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2.5">
          <Micro>In</Micro>
          {target.kind === "fixed" ? (
            <span className="min-w-0 text-[13px]">
              {target.project.name}{" "}
              <span className="font-mono text-[11px] break-all text-muted-foreground">
                {target.project.folderPath}
              </span>
            </span>
          ) : (
            <Select
              value={chosenId}
              onValueChange={(value) => {
                if (value === ADD_PROJECT) {
                  setAdding(true);
                  return;
                }
                setChosenId(value);
              }}
              disabled={disabled}
            >
              <SelectTrigger
                aria-label="Project"
                size="sm"
                className="h-7 min-w-0 max-w-full border-hair-strong text-[13px]"
              >
                <SelectValue placeholder="Choose a project">
                  {chosen !== undefined && <span className="truncate">{chosen.name}</span>}
                </SelectValue>
              </SelectTrigger>
              {/* Popper positioning keeps the list inside a phone's viewport (item-aligned
                  positioning centres it on the trigger and runs off the edge). */}
              <SelectContent position="popper" className="max-w-[calc(100vw-2rem)]">
                {target.projects
                  .filter((project) => project.folder === "present")
                  .map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      <span className="min-w-0 truncate">
                        {project.name}{" "}
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {project.folderPath}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                <SelectSeparator />
                <SelectItem value={ADD_PROJECT}>
                  <Plus /> Add project…
                </SelectItem>
              </SelectContent>
            </Select>
          )}
          <span className="flex-1" />
          <span className="hidden font-mono text-[11px] text-faint sm:inline pointer-coarse:hidden">
            ⌘↵
          </span>
          {onCancel !== null && (
            <Button variant="ghost" onClick={onCancel} disabled={create.isPending}>
              Cancel
            </Button>
          )}
          <Button variant="ink" onClick={start} disabled={!ready}>
            {create.isPending ? (
              <>
                <Loader2 className="animate-spin" /> Start map
              </>
            ) : (
              <>
                Start map <ArrowRight />
              </>
            )}
          </Button>
        </div>
        {disabledReason !== null && (
          <p className="border-t border-border px-4 py-2.5 text-[13px] text-muted-foreground">
            {disabledReason}
          </p>
        )}
      </section>
      {target.kind === "choose" && (
        <AddProjectDialog
          open={adding}
          onOpenChange={setAdding}
          onAdded={(project) => {
            setChosenId(project.id);
          }}
        />
      )}
      {create.error !== null && (
        <RefusalAlert
          error={create.error}
          sentence={createMapRefusalMessage}
          title="Could not start the map"
          showMessage={true}
        />
      )}
    </div>
  );
}
