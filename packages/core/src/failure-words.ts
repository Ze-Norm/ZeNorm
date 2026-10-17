import type { PlanningRunFailureCode, PlanningRunPurpose } from "@zenorm/contracts";

/**
 * The one sentence under a stopped run's headline: why the run stopped, chosen by
 * its failure code, never the code itself. The headline already says what failed ("The planning
 * review failed."), so the sentence says only why, and names the run's output where the code is
 * about the output. Every card, row and activity line about a stopped run reads it from the
 * action's `detail`, so the failure has one presentation across the app.
 */

/** What each purpose's run should have replied with, for the codes about the reply. */
const OUTPUT: Record<Exclude<PlanningRunPurpose, "hatch">, string> = {
  chart: "chart of the map",
  survey: "code survey",
  grilling: "resolution",
  research: "research report",
  task: "task outcome",
  fog: "fog change",
  consistency: "consistency check",
  to_spec: "draft of the spec",
  spec_review: "planning review",
  to_tickets: "draft of the tickets",
  tickets_review: "tickets review",
};

function outputOf(purpose: PlanningRunPurpose): string {
  if (purpose === "hatch") {
    throw new Error("A hatch run's failure shows on its message, never as a next action");
  }
  return OUTPUT[purpose];
}

/** The sentence for a stopped run's failure code, as a next action's `detail`. */
export function stoppedRunWords(code: PlanningRunFailureCode, purpose: PlanningRunPurpose): string {
  switch (code) {
    case "project_folder_missing":
      return "The project's folder is missing; its repository has moved or been deleted.";
    case "agent_cli_missing":
      return "The Claude Code CLI could not be started.";
    case "agent_not_logged_in":
      return "The Claude Code CLI is not logged in. Log in with claude, then try again.";
    case "agent_skill_missing":
      return "A skill the agent needs is missing from ZeNorm's skills folder.";
    case "agent_run_failed":
      return "The agent's session ended with an error before it finished.";
    case "agent_timed_out":
      return "The agent did not finish in time and was stopped.";
    case "agent_output_invalid":
      return `The agent's reply was not a valid ${outputOf(purpose)}.`;
    case "spec_content_invalid":
      return "The agent's spec does not fit the map: its clauses, criteria or sources are inconsistent.";
    case "ticket_set_content_invalid":
      return "The agent's tickets do not fit the spec: their ids, criteria or blockers are inconsistent.";
    case "review_reference_unknown":
      return purpose === "tickets_review"
        ? "The review named a ticket or criterion the tickets and the spec do not have."
        : "The review named a clause, criterion or waypoint the spec does not have.";
    case "waypoint_blocker_unknown":
    case "waypoint_blocker_cycle":
      return "The agent's waypoints named blockers that do not fit the map.";
    case "fog_item_unknown":
      return "The agent's map changes named a fog item the map does not have.";
    case "fog_left_unsettled":
      return "The agent left a fog item unsettled.";
    case "fog_settled_without_resolution":
      return "The agent settled fog with a resolution it did not write.";
    case "consistency_waypoint_unknown":
      return "The consistency check named a waypoint that is not resolved.";
    case "survey_source_unknown":
      return "The code survey named a file or line the project does not have.";
    case "touch_reference_unknown":
      return "The agent's waypoints named a spec, revision or criterion the project does not have.";
    case "review_departure_missed":
      return "The review missed a disposition that departs from the text delta without a reason.";
    case "planning_run_interrupted":
      return "ZeNorm stopped while the agent was working.";
    case "planning_run_internal_error":
      return "The run stopped on an unexpected error; the server log has the details.";
    case "hatch_change_invalid":
      return "The agent's change named a waypoint or fog item the map does not have, or a blocker cycle.";
  }
}

/**
 * A failed delivery run's sentence: the first line of its stored failure message (the agent's
 * messages carry a stderr tail after it), which the run's head shows in full.
 */
export function deliveryFailureWords(message: string): string {
  const [first] = message.split("\n");
  if (first === undefined || first.trim() === "") {
    throw new Error("A failed delivery run has an empty failure message");
  }
  return first.trim();
}
