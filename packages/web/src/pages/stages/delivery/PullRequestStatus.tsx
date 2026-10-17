import type { PullRequest, PullRequestState } from "@zenorm/contracts";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { pullRequestStateWord } from "@/pages/stages/delivery/words";

const STATE_BADGE: Record<PullRequestState, "work" | "bad" | "ok"> = {
  open: "work",
  closed: "bad",
  merged: "ok",
};

/**
 * A run's pull request as the Merge step shows it (C5): its link, which opens it on GitHub, and its
 * recorded state (open, closed or merged). The group is named "Pull request", with `data-state`.
 */
export function PullRequestStatus({ pullRequest }: { pullRequest: PullRequest }) {
  return (
    <div
      role="group"
      aria-label="Pull request"
      data-state={pullRequest.state}
      className="flex flex-wrap items-center gap-2 py-2.5 pr-3.5 pl-3.5 text-[13px] sm:pl-[44px]"
    >
      <a
        href={pullRequest.url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline"
      >
        Pull request #{pullRequest.number} <ExternalLink className="size-3.5" aria-hidden />
      </a>
      <Badge variant={STATE_BADGE[pullRequest.state]}>
        {pullRequestStateWord(pullRequest.state)}
      </Badge>
    </div>
  );
}

/**
 * The pull request card's actions (C5): **Open pull request #n**, which opens it on GitHub to merge
 * there, while it is open; and **Check now** (C4), which reads its state on GitHub at once. A closed
 * pull request offers Check now only (5.1); while the check runs the button reads "Checking pull
 * request #n…". `refusal` is Check now's refusal, beside the buttons; null for none.
 */
export function PullRequestActions({
  pullRequest,
  checking,
  onCheckNow,
  refusal,
}: {
  pullRequest: PullRequest;
  checking: boolean;
  onCheckNow: () => void;
  refusal: ReactNode;
}) {
  const open = pullRequest.state === "open";
  return (
    <div className="flex flex-wrap items-start gap-3">
      {open && (
        <Button asChild>
          <a href={pullRequest.url} target="_blank" rel="noreferrer">
            Open pull request #{pullRequest.number} <ExternalLink />
          </a>
        </Button>
      )}
      <Button
        type="button"
        variant={open ? "outline" : "default"}
        disabled={checking}
        onClick={onCheckNow}
      >
        {checking ? (
          <>
            <Loader2 className="animate-spin" /> Checking pull request #{pullRequest.number}…
          </>
        ) : (
          <>
            <RefreshCw /> Check now
          </>
        )}
      </Button>
      {refusal !== null && <div className="min-w-0 flex-1">{refusal}</div>}
    </div>
  );
}
