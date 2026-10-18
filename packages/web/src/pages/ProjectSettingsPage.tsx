import { isDefinedError } from "@orpc/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  checkNeedsShell,
  REPAIR_LIMIT_MAX,
  SaveProjectSettingsInput,
  type AccessDeniedError,
  type ProjectDetail,
  type SaveProjectSettingsError,
} from "@zenorm/contracts";
import { ArrowLeft, Loader2, X } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { PageHead } from "@/components/parts";
import { QueryRefusal } from "@/components/RouteError";
import { RefusalAlert } from "@/components/RefusalAlert";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { accessDeniedSentence } from "@/lib/access";
import { pageTitle, useDocumentTitle } from "@/lib/document-title";
import { shownQueryError } from "@/lib/query-errors";
import { describeQueryRefusal } from "@/lib/route-error";
import { orpc } from "@/orpc";

/** The sentence shown for a `project.saveSettings` refusal, chosen by its code. */
export function saveSettingsRefusalMessage(
  error: SaveProjectSettingsError | AccessDeniedError,
): string {
  if (error.code === "access_denied") return accessDeniedSentence(error);
  switch (error.code) {
    case "project_not_found":
      return `There is no project ${error.data.projectId}.`;
    case "project_branch_invalid":
      return `${error.data.baseBranch} is not a valid branch name.`;
    case "project_check_invalid":
      return needsShellSentence(error.data.command);
    case "project_fix_command_invalid":
      return fixNeedsShellSentence(error.data.command);
    case "project_app_settings_incomplete":
      return error.data.missing === "appUrl"
        ? "Add the app URL too: screenshots need the start command and the URL together, or neither."
        : "Add the app start command too: screenshots need the start command and the URL together, or neither.";
    case "project_app_url_invalid":
      return `${error.data.url} is not a local address. Use http://localhost or http://127.0.0.1 with the app's port, such as http://localhost:5173.`;
    case "project_app_command_invalid":
      return appNeedsShellSentence(error.data.command);
  }
}

/**
 * The refusal of an app start or setup command that needs a shell, under its field for Add setup
 * command and for a refused save (`project_app_command_invalid`) alike.
 */
export function appNeedsShellSentence(command: string): string {
  return `“${command}” needs a shell. App commands run without one, so quotes, &&, pipes and redirects don't work. Add each setup step as its own setup command.`;
}

/**
 * The refusal of a check that needs a shell, shown by Save settings for Add check and for a
 * refused save alike.
 */
export function needsShellSentence(command: string): string {
  return `“${command}” needs a shell. Checks run without one, so quotes, &&, pipes and redirects don't work. Add each command as its own check.`;
}

/**
 * The refusal of a fix command that needs a shell, under the fix commands field for Add fix
 * command and for a refused save (`project_fix_command_invalid`) alike.
 */
export function fixNeedsShellSentence(command: string): string {
  return `“${command}” needs a shell. Fix commands run without one, so quotes, &&, pipes and redirects don't work. Add each command as its own fix command.`;
}

/** The issue under the repair limit while it is blank or not a whole number from 0 to 10. */
const REPAIR_LIMIT_SENTENCE = `Set a repair limit: a whole number from 0 to ${String(REPAIR_LIMIT_MAX)}.`;

/** What the repair limit does, under its label. */
const REPAIR_LIMIT_DESCRIPTION = `How many times a run whose required checks fail goes back to fix them before it fails, from 0 (no repair) to ${String(REPAIR_LIMIT_MAX)}. Start delivery is unavailable until one is saved.`;

/** What the app settings do, under the app start command's label. */
const APP_SETTINGS_DESCRIPTION =
  "Save the command that starts the project's app and the local address it answers on to show screenshots of changed screens in pull requests. Leave both blank to keep screenshots off.";

/**
 * Project settings: the base branch, the required checks, the repair limit, the fix commands and
 * the app start command, URL and setup commands every delivery run pins at its start, saved with
 * `project.saveSettings`.
 */
export function ProjectSettingsPage({ projectId }: { projectId: string }) {
  const project = useQuery(orpc.project.get.queryOptions({ input: { projectId } }));
  const error = shownQueryError(project.error);
  // A refusal (`project_not_found`, `access_denied`) is the error page, with its title.
  const refusal = error !== null && isDefinedError(error) ? error : null;
  useDocumentTitle(
    pageTitle(
      refusal !== null
        ? [describeQueryRefusal(refusal).title]
        : project.data === undefined
          ? ["Settings"]
          : ["Settings", project.data.name],
    ),
  );
  if (refusal !== null) {
    return <QueryRefusal error={refusal} />;
  }

  return (
    <main className="mx-auto grid max-w-[640px] gap-8 px-4 pt-7 pb-32 sm:px-6 sm:pt-10">
      {error !== null && (
        <Alert variant="destructive">
          <AlertTitle>Could not load the project</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}
      {project.data !== undefined && <ProjectSettingsForm project={project.data} />}
    </main>
  );
}

/**
 * Which field a settings issue belongs under: the base branch, the checks, the repair limit, the
 * fix commands, the app start command, the app URL or the app setup commands.
 */
type SettingsField =
  | "baseBranch"
  | "requiredChecks"
  | "repairLimit"
  | "fixCommands"
  | "appStartCommand"
  | "appUrl"
  | "appSetupCommands";

/** The command lists: each adds commands one at a time and refuses one that needs a shell. */
type CommandField = Extract<SettingsField, "requiredChecks" | "fixCommands" | "appSetupCommands">;

function isSettingsField(field: PropertyKey | undefined): field is SettingsField {
  return (
    field === "baseBranch" ||
    field === "requiredChecks" ||
    field === "repairLimit" ||
    field === "fixCommands" ||
    field === "appStartCommand" ||
    field === "appUrl" ||
    field === "appSetupCommands"
  );
}

/**
 * The field a refused save names, or null for a refusal about the whole save (the project is
 * gone, access denied). `savedStartCommand` is the start command the refused save sent: an app
 * command refusal naming it belongs under it, any other under the setup commands.
 */
function fieldOfRefusal(
  error: SaveProjectSettingsError | AccessDeniedError,
  savedStartCommand: string | null,
): SettingsField | null {
  switch (error.code) {
    case "project_branch_invalid":
      return "baseBranch";
    case "project_check_invalid":
      return "requiredChecks";
    case "project_fix_command_invalid":
      return "fixCommands";
    case "project_app_settings_incomplete":
      return error.data.missing;
    case "project_app_url_invalid":
      return "appUrl";
    case "project_app_command_invalid":
      return savedStartCommand === error.data.command ? "appStartCommand" : "appSetupCommands";
    case "project_not_found":
    case "access_denied":
      return null;
  }
}

/** A typed one-line value: blank is null (not saved), anything else is sent as typed. */
function blankAsNull(value: string): string | null {
  return value.trim() === "" ? null : value;
}

/** A field's issue line, under its input and named by its `aria-describedby`. */
function FieldIssue({ id, issue }: { id: string; issue: string | null }) {
  if (issue === null) {
    return null;
  }
  return (
    <p id={id} role="alert" className="text-[13px] text-bad">
      {issue}
    </p>
  );
}

/**
 * One list of commands, each run without a shell (the required checks, the fix commands): the
 * saved commands with a remove button each, then the draft input and its add button, then the
 * field's issue.
 */
function CommandsField({
  inputId,
  label,
  description,
  empty,
  commands,
  removeLabel,
  onRemove,
  draft,
  onDraftChange,
  onAdd,
  addLabel,
  placeholder,
  issue,
  issueId,
}: {
  inputId: string;
  label: string;
  description: ReactNode;
  /** The line the list shows while it has no command. */
  empty: ReactNode;
  commands: readonly string[];
  removeLabel: (command: string) => string;
  onRemove: (command: string) => void;
  draft: string;
  onDraftChange: (draft: string) => void;
  onAdd: () => void;
  addLabel: string;
  placeholder: string;
  issue: string | null;
  issueId: string;
}) {
  return (
    <section className="grid gap-2">
      <Label htmlFor={inputId}>{label}</Label>
      <p className="text-xs text-muted-foreground">{description}</p>
      <ul className="grid border border-hair-strong bg-card">
        {commands.length === 0 && <li className="px-3 py-2.5 text-sm">{empty}</li>}
        {commands.map((command) => (
          <li
            key={command}
            className="flex items-center gap-2 border-t border-border px-3 py-2 font-mono text-[13px] first:border-t-0"
          >
            <span className="flex-1">{command}</span>
            <Button
              variant="ghost"
              size="icon"
              aria-label={removeLabel(command)}
              onClick={() => {
                onRemove(command);
              }}
            >
              <X />
            </Button>
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <Input
          id={inputId}
          value={draft}
          aria-invalid={issue !== null}
          aria-describedby={issue === null ? undefined : issueId}
          onChange={(event) => {
            onDraftChange(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onAdd();
            }
          }}
          placeholder={placeholder}
          className="font-mono text-[13px]"
        />
        <Button variant="outline" onClick={onAdd} disabled={draft.trim() === ""}>
          {addLabel}
        </Button>
      </div>
      <FieldIssue id={issueId} issue={issue} />
    </section>
  );
}

function ProjectSettingsForm({ project }: { project: ProjectDetail }) {
  const queryClient = useQueryClient();
  const [branch, setBranch] = useState(project.baseBranch);
  const [checks, setChecks] = useState<string[]>(project.requiredChecks);
  const [checkDraft, setCheckDraft] = useState("");
  // The limit as typed: blank until a person saves one (no default).
  const [limit, setLimit] = useState(
    project.repairLimit === null ? "" : String(project.repairLimit),
  );
  const [fixes, setFixes] = useState<string[]>(project.fixCommands);
  const [fixDraft, setFixDraft] = useState("");
  // The app start command and URL as typed: blank until a person saves them (screenshots off).
  const [appStart, setAppStart] = useState(
    project.appStartCommand === null ? "" : project.appStartCommand,
  );
  const [appUrl, setAppUrl] = useState(project.appUrl === null ? "" : project.appUrl);
  const [setups, setSetups] = useState<string[]>(project.appSetupCommands);
  const [setupDraft, setSetupDraft] = useState("");
  /** The one field whose value was refused, with the sentence shown under it; null when none. */
  const [issue, setIssue] = useState<{ field: SettingsField; sentence: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const branchIssueId = useId();
  const checkIssueId = useId();
  const limitIssueId = useId();
  const fixIssueId = useId();
  const appStartIssueId = useId();
  const appUrlIssueId = useId();
  const setupIssueId = useId();

  const save = useMutation(
    orpc.project.saveSettings.mutationOptions({
      onSuccess: async () => {
        setSaved(true);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.project.get.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.map.overview.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.map.overviews.key() }),
        ]);
      },
    }),
  );

  /** Any edit clears the saved badge and the last refusal. */
  function edited() {
    setSaved(false);
    setIssue(null);
    save.reset();
  }

  /**
   * The list with the draft added: a blank or a duplicate is ignored, and a command that needs a
   * shell is refused under its field, as the save would refuse it. Null when nothing is added.
   */
  function withDraft(
    field: CommandField,
    draft: string,
    commands: readonly string[],
    sentence: (command: string) => string,
  ): string[] | null {
    const command = draft.trim();
    if (command === "" || commands.includes(command)) {
      return null;
    }
    edited();
    if (checkNeedsShell(command)) {
      setIssue({ field, sentence: sentence(command) });
      return null;
    }
    return [...commands, command];
  }

  function addCheck() {
    const next = withDraft("requiredChecks", checkDraft, checks, needsShellSentence);
    if (next !== null) {
      setChecks(next);
      setCheckDraft("");
    }
  }

  function addFix() {
    const next = withDraft("fixCommands", fixDraft, fixes, fixNeedsShellSentence);
    if (next !== null) {
      setFixes(next);
      setFixDraft("");
    }
  }

  function addSetup() {
    const next = withDraft("appSetupCommands", setupDraft, setups, appNeedsShellSentence);
    if (next !== null) {
      setSetups(next);
      setSetupDraft("");
    }
  }

  function submit() {
    edited();
    const parsed = SaveProjectSettingsInput.safeParse({
      projectId: project.id,
      baseBranch: branch.trim(),
      requiredChecks: checks,
      // A blank limit is no limit, which the schema refuses: there is no default.
      repairLimit: limit.trim() === "" ? null : Number(limit),
      fixCommands: fixes,
      // A blank start command or URL is not saved; the save refuses one without the other.
      appStartCommand: blankAsNull(appStart),
      appUrl: blankAsNull(appUrl),
      appSetupCommands: setups,
    });
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      if (first === undefined) {
        throw new Error("A failed parse carried no issue");
      }
      const [field] = first.path;
      if (!isSettingsField(field)) {
        throw new Error(`A settings issue names no field: ${String(field)}`);
      }
      setIssue({
        field,
        sentence: field === "repairLimit" ? REPAIR_LIMIT_SENTENCE : first.message,
      });
      return;
    }
    save.mutate(parsed.data);
  }

  /**
   * A refused save about one field shows under that field, as a local issue does; any other
   * refusal (the project is gone, access denied) shows by Save settings.
   */
  const refusedField: SettingsField | null =
    save.error !== null && isDefinedError(save.error) && save.variables !== undefined
      ? fieldOfRefusal(save.error, save.variables.appStartCommand)
      : null;
  const fieldIssue = (field: SettingsField): string | null => {
    if (issue !== null && issue.field === field) {
      return issue.sentence;
    }
    if (refusedField === field && save.error !== null && isDefinedError(save.error)) {
      return saveSettingsRefusalMessage(save.error);
    }
    return null;
  };
  const branchIssue = fieldIssue("baseBranch");
  const checkIssue = fieldIssue("requiredChecks");
  const limitIssue = fieldIssue("repairLimit");
  const fixIssue = fieldIssue("fixCommands");
  const appStartIssue = fieldIssue("appStartCommand");
  const appUrlIssue = fieldIssue("appUrl");
  const setupIssue = fieldIssue("appSetupCommands");

  return (
    <>
      <div className="grid gap-3">
        <div>
          <Button asChild variant="ghost" size="sm" className="-ml-2">
            <Link to="/projects/$projectId" params={{ projectId: project.id }}>
              <ArrowLeft /> Back to {project.name}
            </Link>
          </Button>
        </div>
        <PageHead
          eyebrow={`Project · ${project.name}`}
          title="Project settings"
          lede={<span className="font-mono text-[12px] break-all">{project.folderPath}</span>}
        />
      </div>

      <section className="grid gap-2">
        <Label htmlFor="project-settings-branch">Base branch</Label>
        <Input
          id="project-settings-branch"
          value={branch}
          aria-invalid={branchIssue !== null}
          aria-describedby={branchIssue === null ? undefined : branchIssueId}
          onChange={(event) => {
            setBranch(event.target.value);
            edited();
          }}
          className="max-w-xs font-mono text-[13px]"
        />
        <FieldIssue id={branchIssueId} issue={branchIssue} />
        <p className="text-xs text-muted-foreground">
          Delivery runs branch from here, and a passing run's pull request merges back into it.
        </p>
      </section>

      <CommandsField
        inputId="project-settings-check"
        label="Required checks"
        description="ZeNorm reruns these itself after the agent finishes. They live in ZeNorm, not in the repository, so the delivery agent can't weaken them."
        empty={
          <span className="text-work">
            None yet. Start delivery is unavailable until there is at least one.
          </span>
        }
        commands={checks}
        removeLabel={(check) => `Remove ${check}`}
        onRemove={(check) => {
          setChecks(checks.filter((other) => other !== check));
          edited();
        }}
        draft={checkDraft}
        onDraftChange={(draft) => {
          setCheckDraft(draft);
          // Typing a new command clears the refusal of the last one; it edits nothing yet.
          if (issue?.field === "requiredChecks") {
            setIssue(null);
          }
        }}
        onAdd={addCheck}
        addLabel="Add check"
        placeholder="pnpm test"
        issue={checkIssue}
        issueId={checkIssueId}
      />

      <section className="grid gap-2">
        <Label htmlFor="project-settings-repair-limit">Repair limit</Label>
        <p className="text-xs text-muted-foreground">{REPAIR_LIMIT_DESCRIPTION}</p>
        <Input
          id="project-settings-repair-limit"
          type="number"
          inputMode="numeric"
          min={0}
          max={REPAIR_LIMIT_MAX}
          step={1}
          value={limit}
          aria-invalid={limitIssue !== null}
          aria-describedby={limitIssue === null ? undefined : limitIssueId}
          onChange={(event) => {
            setLimit(event.target.value);
            edited();
          }}
          className="max-w-24 font-mono text-[13px]"
        />
        <FieldIssue id={limitIssueId} issue={limitIssue} />
      </section>

      <CommandsField
        inputId="project-settings-fix-command"
        label="Fix commands"
        description="Commands such as pnpm format that the delivery agent may run to fix its work. Like checks, each runs without a shell."
        empty={<span className="text-muted-foreground">None. Fix commands are optional.</span>}
        commands={fixes}
        removeLabel={(command) => `Remove fix command ${command}`}
        onRemove={(command) => {
          setFixes(fixes.filter((other) => other !== command));
          edited();
        }}
        draft={fixDraft}
        onDraftChange={(draft) => {
          setFixDraft(draft);
          // Typing a new command clears the refusal of the last one; it edits nothing yet.
          if (issue?.field === "fixCommands") {
            setIssue(null);
          }
        }}
        onAdd={addFix}
        addLabel="Add fix command"
        placeholder="pnpm format"
        issue={fixIssue}
        issueId={fixIssueId}
      />

      <section className="grid gap-2">
        <Label htmlFor="project-settings-app-start">App start command</Label>
        <p className="text-xs text-muted-foreground">{APP_SETTINGS_DESCRIPTION}</p>
        <Input
          id="project-settings-app-start"
          value={appStart}
          aria-invalid={appStartIssue !== null}
          aria-describedby={appStartIssue === null ? undefined : appStartIssueId}
          onChange={(event) => {
            setAppStart(event.target.value);
            edited();
          }}
          placeholder="pnpm dev"
          className="font-mono text-[13px]"
        />
        <FieldIssue id={appStartIssueId} issue={appStartIssue} />
      </section>

      <section className="grid gap-2">
        <Label htmlFor="project-settings-app-url">App URL</Label>
        <p className="text-xs text-muted-foreground">
          Where the app answers once started, on localhost or 127.0.0.1.
        </p>
        <Input
          id="project-settings-app-url"
          value={appUrl}
          aria-invalid={appUrlIssue !== null}
          aria-describedby={appUrlIssue === null ? undefined : appUrlIssueId}
          onChange={(event) => {
            setAppUrl(event.target.value);
            edited();
          }}
          placeholder="http://localhost:5173"
          className="font-mono text-[13px]"
        />
        <FieldIssue id={appUrlIssueId} issue={appUrlIssue} />
      </section>

      <CommandsField
        inputId="project-settings-app-setup"
        label="App setup commands"
        description="Commands such as pnpm install that install what the app needs, run in order before the start command. Each runs without a shell."
        empty={<span className="text-muted-foreground">None. The app needs no setup.</span>}
        commands={setups}
        removeLabel={(command) => `Remove setup command ${command}`}
        onRemove={(command) => {
          setSetups(setups.filter((other) => other !== command));
          edited();
        }}
        draft={setupDraft}
        onDraftChange={(draft) => {
          setSetupDraft(draft);
          // Typing a new command clears the refusal of the last one; it edits nothing yet.
          if (issue?.field === "appSetupCommands") {
            setIssue(null);
          }
        }}
        onAdd={addSetup}
        addLabel="Add setup command"
        placeholder="pnpm install"
        issue={setupIssue}
        issueId={setupIssueId}
      />

      <div className="grid gap-3 border-t border-hair-strong pt-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={branch.trim() === "" || save.isPending} onClick={submit}>
            {save.isPending && <Loader2 className="animate-spin" />}
            Save settings
          </Button>
          {saved && <Badge variant="ok">saved</Badge>}
          <span className="text-xs text-muted-foreground">
            A running delivery keeps the values it started with.
          </span>
        </div>
        {save.error !== null && refusedField === null && (
          <RefusalAlert
            error={save.error}
            sentence={saveSettingsRefusalMessage}
            title="Could not save the settings"
            showMessage={false}
          />
        )}
      </div>
    </>
  );
}
