import { useMutation } from "@tanstack/react-query";
import type {
  NextAction,
  NextActionLabel,
  SpecRevisionView,
  TicketSetView,
  TicketsReviewFindingRecord,
} from "@zenorm/contracts";
import { ArrowRight, ChevronRight } from "lucide-react";
import {
  createContext,
  useContext,
  useId,
  useState,
  type ReactNode,
  type SubmitEvent,
} from "react";

import { AgentText } from "@/components/AgentText";
import { useHatch } from "@/components/hatch/HatchProvider";
import { NextActionCard } from "@/components/NextActionCard";
import { RefusalAlert } from "@/components/RefusalAlert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { orpc } from "@/orpc";

import {
  specDecisionRefusalMessage,
  ticketSetDecisionRefusalMessage,
  useInvalidatePlanning,
} from "@/pages/stages/planning/planning";

/** The button label of the action a decision carries out: the card's `NextAction.label`. */
const DecisionLabel = createContext<NextActionLabel | null>(null);

/**
 * Approve, named by the card's action as core labels it, and under it Reject with a reason;
 * Reject waits for a reason.
 */
function DecisionControls({
  subject,
  pending,
  onApprove,
  onReject,
}: {
  /** What Reject names: "the spec" or "the tickets". */
  subject: string;
  pending: boolean;
  onApprove: () => void;
  onReject: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const reasonId = useId();
  const label = useContext(DecisionLabel);
  if (label === null) {
    throw new Error("A decision renders outside a next action card that is yours");
  }

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    onReject(reason);
  }

  return (
    <div className="grid gap-3">
      <div>
        <Button type="button" disabled={pending} onClick={onApprove}>
          {label} <ArrowRight />
        </Button>
      </div>
      <Collapsible className="grid gap-2">
        <div>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="group -ml-2.5">
              <ChevronRight className="transition-transform group-data-[state=open]:rotate-90" />
              Reject with a reason
            </Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          <form noValidate onSubmit={onSubmit} className="grid max-w-[560px] gap-2">
            <Label htmlFor={reasonId}>Reason</Label>
            <Textarea
              id={reasonId}
              value={reason}
              placeholder="What the next draft should change"
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
            <div>
              <Button type="submit" variant="outline" disabled={pending || reason.trim() === ""}>
                Reject {subject}
              </Button>
            </div>
          </form>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/** Approve or reject the undecided spec revision. */
export function SpecDecision({ revision }: { revision: SpecRevisionView }) {
  const invalidate = useInvalidatePlanning();
  const onSuccess = () => invalidate();
  const approve = useMutation(orpc.spec.approve.mutationOptions({ onSuccess }));
  const reject = useMutation(orpc.spec.reject.mutationOptions({ onSuccess }));
  const error = approve.error ?? reject.error;
  return (
    <div className="grid gap-3">
      <DecisionControls
        subject="the spec"
        pending={approve.isPending || reject.isPending}
        onApprove={() => {
          reject.reset();
          approve.mutate({ specRevisionId: revision.id });
        }}
        onReject={(reason) => {
          approve.reset();
          reject.mutate({ specRevisionId: revision.id, reason });
        }}
      />
      {error !== null && (
        <RefusalAlert
          error={error}
          sentence={specDecisionRefusalMessage}
          title="Could not decide the spec"
          showMessage={false}
        />
      )}
    </div>
  );
}

/**
 * Approve or reject the undecided ticket set whose review passed; approving also refreshes the
 * map's delivery. Its Approve carries only "Approve the tickets", or "Confirm" on a set with no
 * ticket, never a held set's label.
 */
export function TicketSetDecision({ ticketSet }: { ticketSet: TicketSetView }) {
  const label = useContext(DecisionLabel);
  if (
    (label !== "Approve the tickets" && label !== "Confirm") ||
    ticketSet.review?.state !== "passed"
  ) {
    throw new Error(
      `Ticket set ${ticketSet.id} offers a decision under ${String(label)} without a passed review`,
    );
  }
  const invalidate = useInvalidatePlanning();
  const approve = useMutation(
    orpc.ticketSet.approve.mutationOptions({ onSuccess: () => invalidate() }),
  );
  const reject = useMutation(
    orpc.ticketSet.reject.mutationOptions({ onSuccess: () => invalidate() }),
  );
  const error = approve.error ?? reject.error;
  return (
    <div className="grid gap-3">
      <DecisionControls
        subject="the tickets"
        pending={approve.isPending || reject.isPending}
        onApprove={() => {
          reject.reset();
          approve.mutate({ ticketSetId: ticketSet.id });
        }}
        onReject={(reason) => {
          approve.reset();
          reject.mutate({ ticketSetId: ticketSet.id, reason });
        }}
      />
      {error !== null && (
        <RefusalAlert
          error={error}
          sentence={ticketSetDecisionRefusalMessage}
          title="Could not decide the ticket set"
          showMessage={false}
        />
      )}
    </div>
  );
}

/**
 * A held ticket set's card body: each escalated finding's title and question, and one button,
 * named by the action's label, that opens and focuses the hatch's composer and sends nothing.
 * There is no Approve or Reject on a held set.
 */
export function HeldTickets({ findings }: { findings: readonly TicketsReviewFindingRecord[] }) {
  const label = useContext(DecisionLabel);
  const { openHatch } = useHatch();
  if (label !== "Tell the agent how to fix it" || findings.length === 0) {
    throw new Error(
      `A held ticket set's card renders under ${String(label)} with ${String(findings.length)} escalated findings`,
    );
  }
  return (
    <div className="grid gap-3">
      <ul aria-label="Escalated findings" className="grid gap-2.5">
        {findings.map((finding, index) => (
          <li key={index} className="grid gap-0.5 border-l-2 border-bad pl-2.5 text-[13.5px]">
            <span className="font-medium text-bad">
              <AgentText text={finding.title} />
            </span>
            <span className="text-muted-foreground">
              <AgentText text={finding.question} />
            </span>
          </li>
        ))}
      </ul>
      <div>
        <Button
          type="button"
          onClick={() => {
            openHatch(null);
          }}
        >
          {label} <ArrowRight />
        </Button>
      </div>
    </div>
  );
}

/**
 * The stage's next-action card: the agent at work, a stopped run with **Try again** on it and
 * core's sentence for why it stopped, or the undecided draft's `decision` when the action is yours,
 * its Approve named by the action's label. The card's headline, its detail and its stopped run are
 * the map's status, so the stopped card is the standard card. Drafts start by themselves, so there
 * is no Start drafting.
 */
export function PlanningCard({
  mapId,
  next,
  decision,
}: {
  mapId: string;
  next: NextAction;
  /**
   * The latest draft's Approve and Reject, a held ticket set's findings and hatch button, or null
   * when nothing waits on a decision.
   */
  decision: ReactNode;
}) {
  // While the agent works on the spec or the map, or the run stopped, nothing is decided here.
  if (next.stopped !== null || decision === null || next.who !== "you") {
    return <NextActionCard mapId={mapId} next={next} />;
  }
  return (
    <NextActionCard mapId={mapId} next={next}>
      <DecisionLabel.Provider value={next.label}>
        <div className="grid gap-3">{decision}</div>
      </DecisionLabel.Provider>
    </NextActionCard>
  );
}
