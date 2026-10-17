import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type {
  Answer,
  Answers,
  MapOverviewDetail,
  NextAction,
  Question,
  QuestionRound as QuestionRoundRecord,
  SubmitAnswersError,
  WayfindingWaypoint,
  WaitingRun,
  WaypointKind,
  WaypointState,
} from "@zenorm/contracts";
import { Check, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import { AgentText } from "@/components/AgentText";
import { ClampedText } from "@/components/ClampedText";
import { Card } from "@/components/ui/card";
import { ActivityColumn } from "@/components/ActivityColumn";
import { useHatch } from "@/components/hatch/HatchProvider";
import { MapAside } from "@/components/PluginSlot";
import { NextActionCard } from "@/components/NextActionCard";
import { Micro, SectionHead } from "@/components/parts";
import { RefusalAlert } from "@/components/RefusalAlert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { WorkspaceColumns, WorkspacePage } from "@/components/WorkspaceColumns";
import { formatMoment } from "@/lib/map";
import { cn } from "@/lib/utils";
import { orpc } from "@/orpc";

import type { AccessDeniedError } from "@zenorm/contracts";
import { accessDeniedSentence } from "@/lib/access";

/**
 * Text behind a trigger, collapsed until the person opens it: the agent-written detail a card or
 * box keeps out of its lead (the evidence behind a finding, a resolution's full prose).
 */
export function Folded({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Collapsible className="grid gap-1.5 justify-self-stretch">
      <CollapsibleTrigger asChild>
        {/* The chevron trails the label and the button's own padding is pulled back (-ml-2, its
            px-2 with an icon), so the label starts at the content's edge. */}
        <Button type="button" variant="ghost" size="sm" className="group -ml-2 w-fit">
          {label}
          <ChevronRight className="transition-transform group-data-[state=open]:rotate-90" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

/** The element at `index`, which the caller knows exists. */
export function at<T>(items: readonly T[], index: number, what: string): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`No ${what} at index ${String(index)}`);
  }
  return item;
}

const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** An ISO timestamp as a day, as a resolution is dated: "Oct 1", in local time. */
export function formatDay(iso: string): string {
  return dayFormat.format(new Date(iso));
}

export function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

export function KindBadge({ kind }: { kind: WaypointKind }) {
  return <Badge variant="outline">{kind}</Badge>;
}

export function pendingRound(rounds: readonly QuestionRoundRecord[]): QuestionRoundRecord | null {
  const pending = rounds.filter((round) => round.status === "pending");
  if (pending.length > 1) {
    throw new Error(`A scope has ${String(pending.length)} pending rounds`);
  }
  const [round] = pending;
  if (round === undefined) {
    return null;
  }
  return round;
}

export function submittedRounds(rounds: readonly QuestionRoundRecord[]): QuestionRoundRecord[] {
  return rounds.filter((round) => round.status === "submitted");
}

/** The waypoints whose blockers include this one: direct dependents only. */
export function dependents(
  detail: MapOverviewDetail,
  waypoint: WayfindingWaypoint,
): WayfindingWaypoint[] {
  return detail.wayfinding.waypoints.filter((candidate) =>
    candidate.blockedBy.includes(waypoint.number),
  );
}

/** A waiting waypoint's run, or null when it does not wait on the person. */
export function waitingRun(waypoint: WayfindingWaypoint): WaitingRun | null {
  return waypoint.state.kind === "waiting" ? waypoint.state.run : null;
}

/** How the index marks a waiting waypoint. */
export function waitingMark(waiting: WaitingRun): string {
  switch (waiting.reason) {
    case "research_unanswered":
      return "report waiting";
    case "task_failed":
      return "task failed";
  }
}

/** Which index entry is open: the overview, the destination round, or a waypoint by number. */
export type IndexSelection = "overview" | "destination" | number;

/** The ring every focused link in the index shows, as `Button`'s. */
const focusRing = "focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none";

const entryClass = cn(
  "grid border-l-2 px-2.5 py-1.5 text-left text-[13px] leading-snug hover:bg-card",
  focusRing,
);

/**
 * Wayfinding's index: Map overview, then each non-empty group with its count. Each
 * waypoint is in the one group its state puts it in. The out-of-scope ones close the index under
 * their own faint group, so every waypoint of the map is reachable from it (the group's label
 * keeps it apart from the overview's Out of scope section).
 */
export function WaypointIndex({
  detail,
  selected,
}: {
  detail: MapOverviewDetail;
  selected: IndexSelection;
}) {
  const mapId = detail.map.id;
  const { waypoints, mapRounds } = detail.wayfinding;
  const destinationWaiting = pendingRound(mapRounds) !== null;
  const inState = (...kinds: WaypointState["kind"][]) =>
    waypoints.filter((waypoint) => kinds.includes(waypoint.state.kind));
  const groups: {
    title: string;
    label: string;
    tone: string;
    waypoints: WayfindingWaypoint[];
  }[] = [
    {
      title: "Waiting on you",
      label: "Waiting on you",
      tone: "text-primary",
      waypoints: inState("waiting_on_you", "stopped", "waiting"),
    },
    {
      title: "Agent working",
      label: "Agent working",
      tone: "text-work",
      waypoints: inState("working"),
    },
    {
      title: "Blocked",
      label: "Blocked",
      tone: "",
      waypoints: inState("blocked", "waits_on_survey"),
    },
    {
      title: "Decisions so far",
      label: "Decisions so far",
      tone: "text-ok",
      waypoints: inState("resolved"),
    },
    {
      title: "Out of scope",
      label: "Out of scope waypoints",
      tone: "text-faint",
      waypoints: inState("out_of_scope"),
    },
  ];

  return (
    <nav aria-label="Waypoints" className="grid content-start gap-5">
      <Link
        to="/maps/$mapId/$stage"
        params={{ mapId, stage: "wayfinding" }}
        className={cn(
          "border-l-2 px-2.5 py-1 text-left text-[13px] font-semibold",
          focusRing,
          selected === "overview"
            ? "border-ink-line"
            : "border-transparent text-muted-foreground hover:text-foreground",
        )}
      >
        Map overview
      </Link>
      {groups.map((group) => {
        const count =
          group.waypoints.length + (group.title === "Waiting on you" && destinationWaiting ? 1 : 0);
        if (count === 0) {
          return null;
        }
        return (
          <section key={group.title} aria-label={group.label} className="grid gap-1">
            <Micro className={cn("px-2.5", group.tone)}>
              {group.title} · {count}
            </Micro>
            {group.title === "Waiting on you" && destinationWaiting && (
              <Link
                to="/maps/$mapId/wayfinding/destination"
                params={{ mapId }}
                className={cn(
                  entryClass,
                  selected === "destination" ? "border-ink-line bg-card" : "border-primary",
                )}
              >
                <span>Destination</span>
              </Link>
            )}
            {group.waypoints.map((waypoint) => (
              <IndexEntry
                key={waypoint.id}
                mapId={mapId}
                waypoint={waypoint}
                selected={selected === waypoint.number}
                waiting={group.title === "Waiting on you"}
              />
            ))}
          </section>
        );
      })}
    </nav>
  );
}

/** How the index marks a waypoint after its kind; null where its group says it all. */
function indexMark(state: WaypointState): string | null {
  switch (state.kind) {
    case "working":
      return "agent working";
    case "stopped":
      return "stopped";
    case "waiting":
      return waitingMark(state.run);
    case "blocked":
      return `waits on ${state.waitsOn.join(", ")}`;
    case "waits_on_survey":
      return "waits on the code survey";
    case "resolved":
    case "out_of_scope":
    case "waiting_on_you":
      return null;
  }
}

function IndexEntry({
  mapId,
  waypoint,
  selected,
  waiting,
}: {
  mapId: string;
  waypoint: WayfindingWaypoint;
  selected: boolean;
  waiting: boolean;
}) {
  const mark = indexMark(waypoint.state);
  return (
    <Link
      to="/maps/$mapId/wayfinding/$number"
      params={{ mapId, number: waypoint.number }}
      className={cn(
        entryClass,
        selected ? "border-ink-line bg-card" : waiting ? "border-primary" : "border-transparent",
      )}
    >
      <span
        className={cn(
          waypoint.status === "resolved" && "text-muted-foreground",
          waypoint.status === "out_of_scope" && "text-faint",
        )}
      >
        {waypoint.title}
      </span>
      <span className="text-[11.5px] text-faint">
        {waypoint.kind}
        {mark !== null && ` · ${mark}`}
      </span>
    </Link>
  );
}

/**
 * The frame of Wayfinding's child routes, as `StageView` frames the stage page: the workspace
 * shell (`WorkspaceColumns`) with the page, and the Activity column beside it, a sheet below the
 * columns breakpoint.
 */
export function WayfindingFrame({
  detail,
  selected,
  head,
  children,
}: {
  detail: MapOverviewDetail;
  selected: IndexSelection;
  head: ReactNode;
  children: ReactNode;
}) {
  const { focusRequest } = useHatch();
  return (
    <WorkspaceColumns
      label="Activity"
      openOn={focusRequest}
      column={
        <ActivityColumn
          detail={detail}
          stage="wayfinding"
          specNumber={null}
          aside={
            <MapAside projectId={detail.project.id} mapId={detail.map.id} stage="wayfinding" />
          }
        />
      }
    >
      <WayfindingPage detail={detail} selected={selected} head={head}>
        {children}
      </WayfindingPage>
    </WorkspaceColumns>
  );
}

/** What the index's collapsed trigger says below the split: the open entry, so the person knows where they are. */
function selectionLabel(detail: MapOverviewDetail, selected: IndexSelection): string {
  if (selected === "overview") return "Map overview";
  if (selected === "destination") return "Destination";
  const waypoint = detail.wayfinding.waypoints.find((entry) => entry.number === selected);
  if (waypoint === undefined) {
    throw new Error(`Map ${detail.map.id} has no waypoint ${String(selected)} to select`);
  }
  return waypoint.title;
}

/**
 * A Wayfinding page on the workspace's measure (`WorkspacePage`): the head, then the index of
 * waypoints at the left with the content beside it; below `md` the index folds above the content
 * behind one row naming the open entry.
 */
export function WayfindingPage({
  detail,
  selected,
  head,
  children,
}: {
  detail: MapOverviewDetail;
  selected: IndexSelection;
  head: ReactNode;
  children: ReactNode;
}) {
  return (
    <WorkspacePage
      head={head}
      index={<WaypointIndex detail={detail} selected={selected} />}
      folded={
        <Collapsible className="grid gap-2 border-y border-border py-3">
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="group w-fit max-w-full justify-start"
            >
              <ChevronRight className="transition-transform group-data-[state=open]:rotate-90" />
              <span className="truncate">Waypoints · {selectionLabel(detail, selected)}</span>
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <WaypointIndex detail={detail} selected={selected} />
          </CollapsibleContent>
        </Collapsible>
      }
    >
      {children}
    </WorkspacePage>
  );
}

/** The sentence shown for a `questionRound.submit` refusal, chosen by its code. */
function submitRefusalMessage(error: SubmitAnswersError | AccessDeniedError): string {
  if (error.code === "access_denied") return accessDeniedSentence(error);
  switch (error.code) {
    case "round_not_found":
      return "This question round no longer exists.";
    case "round_answers_invalid":
      return error.data.questionIndex === null
        ? "The answers do not match the round's questions."
        : `Question ${String(error.data.questionIndex + 1)} needs an option, your words, or both.`;
    case "round_already_submitted":
      return "This round has already been answered.";
    case "round_split_undecided":
      return "Create or dismiss each suggested map above before you send the answers.";
  }
}

/** `questionRound.submit`, invalidating the map's reads, and its refusal shown by code. */
export function useSubmitAnswers(): {
  submit: (roundId: string, answers: Answers) => void;
  submitting: boolean;
  refusal: ReactNode;
} {
  const queryClient = useQueryClient();
  const mutation = useMutation(
    orpc.questionRound.submit.mutationOptions({
      onSuccess: () =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.map.overview.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.map.overviews.key() }),
        ]),
    }),
  );
  return {
    submit: (roundId, answers) => {
      mutation.mutate({ roundId, answers });
    },
    submitting: mutation.isPending,
    refusal:
      mutation.error === null ? null : (
        <RefusalAlert
          error={mutation.error}
          sentence={submitRefusalMessage}
          title="Could not send the answers"
          showMessage={false}
        />
      ),
  };
}

/**
 * Submitted rounds in the record form: "Questions and answers" with the round count,
 * then per round when it was asked and answered and each question's chosen option, words and
 * the options not chosen.
 */
export function RoundsRecord({
  rounds,
  resolved,
}: {
  rounds: readonly QuestionRoundRecord[];
  resolved: boolean;
}) {
  return (
    <section aria-label="Questions and answers" className="grid gap-3">
      <SectionHead
        title="Questions and answers"
        right={<Micro>{plural(rounds.length, "round")}</Micro>}
      />
      {resolved && (
        <p className="text-[12.5px] text-muted-foreground">
          The resolution above was written from these answers.
        </p>
      )}
      {rounds.map((round) => {
        if (round.answers === null || round.submittedAt === null) {
          throw new Error(`Round ${round.id} is in the record but not submitted`);
        }
        const answers = round.answers;
        return (
          <section
            key={round.id}
            aria-label={`Round ${String(round.number)}`}
            className="grid gap-1.5"
          >
            <Micro>
              Round {round.number} · asked {formatMoment(round.askedAt)} · answered{" "}
              {formatMoment(round.submittedAt)}
            </Micro>
            <Card className="grid">
              {round.questions.map((question, questionIndex) => (
                <AnsweredQuestion
                  key={questionIndex}
                  question={question}
                  answer={at(answers, questionIndex, "answer")}
                />
              ))}
            </Card>
          </section>
        );
      })}
    </section>
  );
}

function AnsweredQuestion({ question, answer }: { question: Question; answer: Answer }) {
  const chosen =
    answer.optionIndex === null ? null : at(question.options, answer.optionIndex, "option");
  const notChosen = question.options
    .map((option, optionIndex) => ({ option, optionIndex }))
    .filter(({ optionIndex }) => optionIndex !== answer.optionIndex);
  const note = answer.note.trim();

  return (
    <div className="grid gap-1.5 border-t border-border px-3.5 py-3 first:border-t-0">
      <p className="text-[13px] text-muted-foreground">
        <AgentText text={question.text} />
      </p>
      {chosen !== null && (
        <div className="grid grid-cols-[16px_1fr] gap-x-2">
          <Check className="mt-[3px] size-3.5 text-ok" aria-label="Chosen" />
          <div className="grid gap-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[14px] font-semibold">{chosen.label}</span>
              {answer.accepted ? (
                <Badge variant="secondary">recommendation accepted</Badge>
              ) : (
                answer.optionIndex === 0 && <Badge variant="outline">recommended</Badge>
              )}
            </div>
            <span className="text-[13px] text-muted-foreground">{chosen.detail}</span>
          </div>
        </div>
      )}
      {note !== "" && (
        <div className="ml-6 border-l-2 border-ink-line pl-2.5 text-[13.5px]">
          <Micro>{chosen === null ? "Your own answer" : "You added"}</Micro>
          <ClampedText as="div" lines={4} className="whitespace-pre-wrap">
            {note}
          </ClampedText>
        </div>
      )}
      {notChosen.length > 0 && (
        <p className="ml-6 text-[12px] text-faint">
          Not chosen:{" "}
          {notChosen
            .map(({ option, optionIndex }) =>
              optionIndex === 0 ? `${option.label} (recommended)` : option.label,
            )
            .join(" · ")}
        </p>
      )}
    </div>
  );
}

/**
 * A stopped scope's next-action card: the standard card, whose detail says why the run stopped and
 * whose action is **Try again**; a card with no stopped run is a programmer error here.
 */
export function StoppedRunCard({ mapId, next }: { mapId: string; next: NextAction }) {
  if (next.stopped === null) {
    throw new Error(`Next action "${next.headline}" has no stopped run`);
  }
  return <NextActionCard mapId={mapId} next={next} />;
}
