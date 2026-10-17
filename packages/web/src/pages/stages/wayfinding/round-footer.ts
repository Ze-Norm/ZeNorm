import { isLastMapRound, type QuestionRound } from "@zenorm/contracts";

/**
 * The open round's footer line (spec D8, DR-18), pure so it is tested without a DOM. A map-level
 * round: the last (`isLastMapRound`) says sending it confirms the destination; any other (round 1
 * always is) says the agent confirms from the answers or asks a short follow-up. A waypoint round:
 * its last round's resolution line, or that the answers may open further questions.
 */
export function roundFooter(round: Pick<QuestionRound, "waypointId" | "number" | "final">): string {
  if (round.waypointId === null) {
    return isLastMapRound(round)
      ? "Sending these answers confirms the destination."
      : "The agent confirms the destination from your answers, or asks a short follow-up if they change the scope.";
  }
  return round.final
    ? "This is the waypoint's last round: its resolution is written from your answers."
    : "Your answers may open further questions: the agent reads them before it asks or resolves.";
}
