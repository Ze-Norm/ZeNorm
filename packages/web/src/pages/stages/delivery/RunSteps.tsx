import type { CheckResult, SpecRun, TicketContent, VerdictFinding } from "@zenorm/contracts";
import { Check, Loader2, X } from "lucide-react";
import type { ReactNode } from "react";

import { AgentText } from "@/components/AgentText";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  closingMark,
  mergeMark,
  repairAttempt,
  repairedVerifyLine,
  repairLine,
  stepMark,
  type MergeMark,
  type RunStep,
  type StepMark,
} from "@/pages/stages/delivery/steps";
import {
  ClosingRow,
  RunTickets,
  UnrecordedTickets,
  type RunTicketLinks,
} from "@/pages/stages/delivery/RunTickets";
import { PullRequestStatus } from "@/pages/stages/delivery/PullRequestStatus";
import { checkOutcome, plural, required, type CheckOutcome } from "@/pages/stages/delivery/words";

type Mark = StepMark | MergeMark;

const MARK_WORDS: Record<Mark, string> = {
  done: "Done",
  working: "Working",
  stopped: "Stopped here",
  "not-reached": "Not reached",
  yours: "Yours",
};

function Step({
  n,
  name,
  mark,
  running,
  line,
  children,
}: {
  n: number;
  name: string;
  mark: Mark;
  /** A step a running run has not reached yet is pending, not faint like one an ended run skipped. */
  running: boolean;
  line: ReactNode;
  children?: ReactNode;
}) {
  const faint = mark === "not-reached" && !running;
  return (
    <section
      aria-label={name}
      data-mark={mark}
      className="border-t border-hair-strong first:border-t-0"
    >
      <div
        className={cn(
          "grid grid-cols-[18px_84px_1fr] items-baseline gap-x-3 px-3.5 py-3",
          mark === "working" && "bg-work-soft/50",
          mark === "yours" && "bg-primary-soft",
        )}
      >
        <span
          className={cn(
            "grid size-[18px] place-items-center self-center border font-mono text-[11px] font-semibold",
            mark === "done" && "border-ok-dot bg-ok-dot text-white",
            mark === "working" && "border-work-dot text-work",
            mark === "stopped" && "border-bad-dot bg-bad-dot text-white",
            mark === "yours" && "border-primary-fill bg-primary-fill text-primary-fill-foreground",
            mark === "not-reached" && "border-hair-strong text-faint",
          )}
        >
          {mark === "done" ? (
            <Check className="size-3" strokeWidth={3} aria-hidden />
          ) : mark === "stopped" ? (
            <X className="size-3" strokeWidth={3} aria-hidden />
          ) : mark === "working" ? (
            <Loader2 className="size-3 animate-spin" aria-hidden />
          ) : (
            <span aria-hidden>{n}</span>
          )}
          <span className="sr-only">{MARK_WORDS[mark]}</span>
        </span>
        <h3
          className={cn(
            "font-display text-[14px] font-semibold tracking-[-0.01em]",
            faint && "text-faint",
          )}
        >
          {name}
        </h3>
        <p
          className={cn(
            "text-[13px]",
            mark === "stopped"
              ? "text-bad"
              : mark === "working"
                ? "text-work"
                : mark === "yours"
                  ? "text-primary"
                  : faint
                    ? "text-faint"
                    : "text-muted-foreground",
          )}
        >
          {line}
        </p>
      </div>
      {children !== undefined && <div className="border-t border-border">{children}</div>}
    </section>
  );
}

const OUTCOME_TONE: Record<CheckOutcome, string> = {
  passed: "text-ok",
  failed: "text-bad",
  "timed out": "text-bad",
};

const ROW = "flex items-center gap-2 py-2 pr-3.5 pl-3.5 font-mono text-[12.5px] sm:pl-[44px]";

/** A check with its result; its output on demand when it printed any. */
function CheckRow({ result }: { result: CheckResult }) {
  const outcome = checkOutcome(result);
  const row = (
    <>
      {outcome === "passed" ? (
        <Check className="size-3.5 text-ok" aria-hidden />
      ) : (
        <X className="size-3.5 text-bad" aria-hidden />
      )}
      <span className="flex-1">{result.command}</span>
      <span className="text-[11px] text-faint">{(result.durationMs / 1000).toFixed(1)} s</span>
      <span className={cn("w-16 text-right text-[11px]", OUTCOME_TONE[outcome])}>{outcome}</span>
    </>
  );
  if (result.outputTail === "") {
    return <div className={cn(ROW, "border-t border-border first:border-t-0")}>{row}</div>;
  }
  return (
    <Collapsible className="border-t border-border first:border-t-0">
      <CollapsibleTrigger className={cn(ROW, "w-full text-left hover:bg-secondary")}>
        {row}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="border-t border-border bg-background py-2 pr-3.5 pl-[66px] font-mono text-[11.5px] whitespace-pre-wrap text-muted-foreground">
          {result.outputTail}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A check with no result yet: the command as pinned on the run, running or not run. */
function PendingCheckRow({ command, running }: { command: string; running: boolean }) {
  return (
    <div className={cn(ROW, "border-t border-border first:border-t-0")}>
      {running ? (
        <Loader2 className="size-3.5 animate-spin text-work" aria-hidden />
      ) : (
        <span className="size-3.5" />
      )}
      <span className="flex-1">{command}</span>
      <span className={cn("w-16 text-right text-[11px]", running ? "text-work" : "text-faint")}>
        {running ? "running" : "not run"}
      </span>
    </div>
  );
}

/** The check results stored so far: each is stored as it finishes, none before the first. */
function storedResults(run: SpecRun): readonly CheckResult[] {
  if (run.checkResults === null) {
    return [];
  }
  return run.checkResults;
}

/** A note of the verdict, not blocking, as a Review step row. */
function NoteRow({ finding }: { finding: VerdictFinding }) {
  return (
    <div className="grid gap-0.5 border-t border-border py-2.5 pr-3.5 pl-3.5 text-[13px] first:border-t-0 sm:pl-[44px]">
      <span>
        <span className="font-medium">
          Note, not blocking: <AgentText text={finding.title} />.
        </span>{" "}
        <span className="text-muted-foreground">
          <AgentText text={finding.detail} />
        </span>
      </span>
      {finding.file !== null && (
        <code className="font-mono text-[11.5px] text-muted-foreground">{finding.file}</code>
      )}
    </div>
  );
}

/**
 * "The run, step by step": Prepare; Implement, with each pinned ticket's status from
 * `map.overview`; Verify, each check with its output on demand; Review, the verdict and its notes
 * (blocking findings stand above the card); and Merge, the person's, which also shows ZeNorm
 * opening the pull request (`publishing`, 5.4). Steps are marked by the run's stored phase; the
 * step a run stopped in says why.
 */
export function RunSteps({
  run,
  tickets,
  revision,
  links,
}: {
  run: SpecRun;
  /** The run's ticket set's tickets, in pinned order. */
  tickets: readonly TicketContent[];
  /** The spec revision the run's ticket set was cut from. */
  revision: number;
  /** Where the ticket rows link. */
  links: RunTicketLinks;
}) {
  const mark = (step: RunStep) => stepMark(run, step);
  const running = run.state === "running";

  /** Why the run stopped in the step it stopped in. */
  function stoppedLine(): ReactNode {
    switch (run.state) {
      case "failed":
        // The stored reason, as the head's lede.
        return <AgentText text={required(run.failure, "failure", run).message} />;
      case "blocked": {
        const blocking = required(run.verdict, "verdict", run).findings.filter(
          (finding) => finding.severity === "blocking",
        ).length;
        return `${plural(blocking, "blocking finding")}, set out above.`;
      }
      case "cancelled":
        return "You cancelled the run here.";
      case "interrupted":
        return "The run stopped here when ZeNorm restarted.";
      case "running":
      case "passed":
        throw new Error(`Run ${String(run.number)} is ${run.state}; no step is stopped`);
    }
  }

  function line(
    step: RunStep,
    texts: {
      pending: ReactNode;
      working: ReactNode;
      done: () => ReactNode;
      /** The step's own words for where the run stopped, in place of the run's reason. */
      stopped?: ReactNode;
    },
  ) {
    switch (mark(step)) {
      case "done":
        return texts.done();
      case "working":
        return texts.working;
      case "stopped":
        return texts.stopped === undefined ? stoppedLine() : texts.stopped;
      case "not-reached":
        return running ? texts.pending : "Not reached.";
    }
  }

  const { checks } = run;
  const results = storedResults(run);
  const passedChecks = results.filter((result) => checkOutcome(result) === "passed").length;
  const verdict = run.verdict;
  const notes = verdict === null ? [] : verdict.findings.filter((f) => f.severity === "note");
  const merge = mergeMark(run);
  const closing = closingMark(run);
  // A run that reached publishing passed its review; its verdict is stored only once the run
  // passes (a run that failed or stopped publishing keeps none).
  const reviewed = () =>
    verdict === null && run.phase === "publishing" ? (
      "The review passed with no blocking finding."
    ) : (
      <AgentText text={required(verdict, "verdict", run).summary} />
    );
  const mergedTickets =
    run.tickets === null
      ? null
      : run.tickets.filter((ticket) => ticket.status.state === "merged").length;
  const prepared = (
    <>
      Branch <code className="font-mono text-[11.5px]">{run.branch}</code> from {run.baseBranch}.
      Spec r{revision}, {plural(tickets.length, "ticket")} and{" "}
      {plural(checks.length, "required check")} pinned: edits made during the run don&apos;t reach
      it.
    </>
  );
  const implemented =
    mergedTickets === null
      ? `${plural(tickets.length, "ticket")} implemented on the run branch.`
      : `${String(mergedTickets)} of ${plural(tickets.length, "ticket")} implemented.`;
  const checksPassed = `${String(passedChecks)} of ${plural(checks.length, "required check")} passed, rerun by ZeNorm itself.`;
  const verifying = mark("verify");
  // While a repair attempt runs the steps go back to Implement.
  const repair = repairAttempt(run);
  const implementing = repair === null ? implemented : repairLine(repair);
  // A run that made repair attempts says how many on its Verify line.
  const repairedPass = repairedVerifyLine(run, true);
  const verified = repairedPass ?? checksPassed;
  const stillFailing =
    run.failure !== null && run.failure.code === "delivery_checks_failed"
      ? repairedVerifyLine(run, false)
      : null;

  return (
    <section aria-labelledby="run-steps-heading" className="grid gap-2">
      <h2
        id="run-steps-heading"
        className="font-display text-base font-semibold tracking-[-0.015em]"
      >
        The run, step by step
      </h2>
      <div className="grid border border-hair-strong bg-card">
        <Step
          n={1}
          name="Prepare"
          mark={mark("prepare")}
          running={running}
          line={line("prepare", { pending: prepared, working: prepared, done: () => prepared })}
        />
        <Step
          n={2}
          name="Implement"
          mark={mark("implement")}
          running={running}
          line={line("implement", {
            pending: `${plural(tickets.length, "ticket")}. Each starts as soon as nothing blocks it.`,
            working: implementing,
            done: () => implemented,
          })}
        >
          {run.tickets === null ? (
            <UnrecordedTickets tickets={tickets} />
          ) : (
            <RunTickets
              rows={run.tickets}
              tickets={tickets}
              runState={run.state}
              executor={run.executor}
              links={links}
            />
          )}
          {closing !== null && <ClosingRow mark={closing} checks={checks.length} />}
        </Step>
        <Step
          n={3}
          name="Verify"
          mark={verifying}
          running={running}
          line={line("verify", {
            pending: `ZeNorm reruns the ${plural(checks.length, "required check")} itself, whatever the agent reported.`,
            working: checksPassed,
            done: () => verified,
            ...(stillFailing === null ? {} : { stopped: stillFailing }),
          })}
        >
          {verifying === "not-reached" && !running ? undefined : (
            <div aria-label="Check results" role="list">
              {checks.map((command, index) => {
                const result = results[index];
                return (
                  <div role="listitem" key={index}>
                    {result === undefined ? (
                      <PendingCheckRow
                        command={command}
                        running={verifying === "working" && index === results.length}
                      />
                    ) : (
                      <CheckRow result={result} />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Step>
        <Step
          n={4}
          name="Review"
          mark={mark("review")}
          running={running}
          line={line("review", {
            pending:
              "A fresh, read-only session reviews the branch against the spec. Its verdict ends the run.",
            working: "A fresh, read-only session is reading the branch against the spec.",
            done: reviewed,
          })}
        >
          {notes.length === 0
            ? undefined
            : notes.map((finding, index) => <NoteRow key={index} finding={finding} />)}
        </Step>
        <Step n={5} name="Merge" mark={merge} running={running} line={mergeLine()}>
          {run.pullRequest === null ? undefined : (
            <PullRequestStatus pullRequest={run.pullRequest} />
          )}
        </Step>
      </div>
    </section>
  );

  /** The Merge step's line: on a run with a pull request, the person merges it on GitHub. */
  function mergeLine(): ReactNode {
    switch (merge) {
      case "done":
        // A pull request merged on GitHub may be a squash or rebase: its final commit is not in base.
        return run.pullRequest === null
          ? `${required(run.finalCommit, "final commit", run).slice(0, 7)} is in ${run.baseBranch}. The tickets are recorded as delivered.`
          : `Pull request #${String(run.pullRequest.number)} is merged into ${run.baseBranch}. The tickets are recorded as delivered.`;
      case "yours":
        if (run.pullRequest === null) {
          return `Yours: merge the branch into ${run.baseBranch}, then mark it merged.`;
        }
        return run.pullRequest.state === "closed"
          ? `Pull request #${String(run.pullRequest.number)} was closed on GitHub without being merged. Reopen and merge it there, then Check now.`
          : `Yours: merge pull request #${String(run.pullRequest.number)} into ${run.baseBranch} on GitHub.`;
      case "working":
        return "ZeNorm is pushing the branch and opening its pull request on GitHub.";
      case "stopped":
        return stoppedLine();
      case "not-reached":
        return running
          ? `Yours, once the run passes: ZeNorm never merges into ${run.baseBranch}.`
          : "Nothing to merge. The branch is kept with the record.";
    }
  }
}
