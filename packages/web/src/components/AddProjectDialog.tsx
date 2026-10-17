import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  InspectProjectInput,
  type CreateProjectError,
  type Project,
  type ProjectInspection,
} from "@zenorm/contracts";
import { Loader2 } from "lucide-react";
import { useState, type SubmitEvent } from "react";

import { RefusalAlert } from "@/components/RefusalAlert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { orpc } from "@/orpc";

/** The sentence shown for a `project.inspect` or `project.create` refusal, chosen by its code. */
function refusalMessage(error: CreateProjectError): string {
  switch (error.code) {
    case "project_folder_missing":
      return `There is no folder at ${error.data.folderPath}.`;
    case "project_not_git":
      return error.data.repositoryTopLevel === null
        ? `${error.data.folderPath} is not in a git repository.`
        : `${error.data.folderPath} is inside the repository at ${error.data.repositoryTopLevel}. Add the repository's top level instead.`;
    case "project_branch_missing":
      return `There is no branch ${error.data.baseBranch} with a commit.`;
    case "project_branch_invalid":
      return `${error.data.baseBranch} is not a valid branch name.`;
    case "project_already_added":
      return `The repository at ${error.data.folderPath} is already a project.`;
    case "project_inside_project":
      return `${error.data.folderPath} is inside the project at ${error.data.projectFolderPath}.`;
  }
}

/**
 * Add project (spec D7): **Check** a folder with `project.inspect`, confirm the detected base
 * branch, then **Add project** stores it with `project.create`. Controlled, so the switcher and
 * any page can open it from their own trigger. `onAdded` receives the new project in place of
 * opening its page (the map composer selects it, keeping the idea); null opens its page.
 */
export function AddProjectDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: ((project: Project) => void) | null;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [folder, setFolder] = useState("");
  const [folderIssue, setFolderIssue] = useState<string | null>(null);
  const [inspection, setInspection] = useState<ProjectInspection | null>(null);
  const [branch, setBranch] = useState("");

  const inspect = useMutation(
    orpc.project.inspect.mutationOptions({
      onSuccess: (found) => {
        setInspection(found);
        // Prefilled with the detected branch; empty for a detached HEAD, which the person types.
        if (found.detectedBaseBranch === null) {
          setBranch("");
        } else {
          setBranch(found.detectedBaseBranch);
        }
      },
    }),
  );

  const create = useMutation(
    orpc.project.create.mutationOptions({
      onSuccess: async (project) => {
        await queryClient.invalidateQueries({ queryKey: orpc.project.key() });
        reset();
        onOpenChange(false);
        if (onAdded !== null) {
          onAdded(project);
          return;
        }
        await navigate({ to: "/projects/$projectId", params: { projectId: project.id } });
      },
    }),
  );

  function clearResult() {
    setFolderIssue(null);
    setInspection(null);
    setBranch("");
    inspect.reset();
    create.reset();
  }

  function reset() {
    setFolder("");
    clearResult();
  }

  function check(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    clearResult();
    const parsed = InspectProjectInput.safeParse({ folderPath: folder.trim() });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      if (issue === undefined) {
        throw new Error("A failed parse carried no issue");
      }
      setFolderIssue(issue.message);
      return;
    }
    inspect.mutate(parsed.data);
  }

  const baseBranch = branch.trim();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="border-ink-line">
        <DialogHeader>
          <DialogTitle className="font-display tracking-[-0.015em]">Add project</DialogTitle>
          <DialogDescription>
            A project is a git repository. Its maps plan and deliver against this folder.
          </DialogDescription>
        </DialogHeader>

        <form noValidate onSubmit={check} className="grid gap-2">
          <Label htmlFor="add-project-folder">Folder</Label>
          <div className="flex gap-2">
            <Input
              id="add-project-folder"
              value={folder}
              placeholder="/absolute/path/to/repository"
              className="font-mono text-[13px]"
              aria-invalid={folderIssue !== null}
              onChange={(event) => {
                setFolder(event.target.value);
                clearResult();
              }}
            />
            <Button
              type="submit"
              variant="outline"
              disabled={folder.trim() === "" || inspect.isPending}
            >
              {inspect.isPending && <Loader2 className="animate-spin" />}
              Check
            </Button>
          </div>
          {folderIssue !== null && <p className="text-xs text-bad">{folderIssue}</p>}
        </form>

        {inspect.error !== null && (
          <RefusalAlert
            error={inspect.error}
            sentence={refusalMessage}
            title="Could not check the folder"
            showMessage={false}
          />
        )}

        {inspection !== null && (
          <div className="grid gap-3 border border-hair-strong bg-secondary p-3">
            <div className="text-sm">
              <span className="font-semibold">{inspection.name}</span>{" "}
              <span className="font-mono text-[11px] text-muted-foreground">
                {inspection.folderPath}
              </span>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="add-project-branch">Base branch · detected, confirm it</Label>
              <Input
                id="add-project-branch"
                value={branch}
                onChange={(event) => {
                  setBranch(event.target.value);
                  create.reset();
                }}
                className="font-mono text-[13px]"
              />
            </div>
            {!inspection.hasCommit && (
              <p className="text-xs text-work">
                Planning works; Start delivery waits for a commit on {baseBranch}.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Required checks and a repair limit start unset. Delivery stays unavailable until you
              set both.
            </p>
          </div>
        )}

        {create.error !== null && (
          <RefusalAlert
            error={create.error}
            sentence={refusalMessage}
            title="Could not add the project"
            showMessage={false}
          />
        )}

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            disabled={inspection === null || baseBranch === "" || create.isPending}
            onClick={() => {
              if (inspection === null) {
                throw new Error("Add project ran without a checked folder");
              }
              create.mutate({ folderPath: inspection.folderPath, baseBranch });
            }}
          >
            {create.isPending && <Loader2 className="animate-spin" />}
            Add project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
