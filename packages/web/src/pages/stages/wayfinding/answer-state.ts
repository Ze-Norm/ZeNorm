import type { Answer, Answers, Question } from "@zenorm/contracts";

/**
 * The open question round's answer state, pure so it is tested without a DOM:
 * one answer per question, positional. An answer counts once it has an option, words, or both;
 * `accepted` marks option 0 taken through Accept the rest, with no words, so any edit to
 * an accepted answer makes it the person's own.
 */

/** The element at `index`, which the caller knows exists. */
function at<T>(items: readonly T[], index: number, what: string): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`No ${what} at index ${String(index)}`);
  }
  return item;
}

function replace(answers: Answers, index: number, answer: Answer): Answers {
  at(answers, index, "answer");
  return answers.map((current, i) => (i === index ? answer : current));
}

/** Every question unanswered. */
export function initialAnswers(questions: readonly Question[]): Answers {
  return questions.map(() => ({ optionIndex: null, note: "", accepted: false }));
}

/** Choose option `optionIndex` on question `questionIndex`, keeping its words. */
export function choose(
  questions: readonly Question[],
  answers: Answers,
  questionIndex: number,
  optionIndex: number,
): Answers {
  const question = at(questions, questionIndex, "question");
  at(question.options, optionIndex, "option");
  const answer = at(answers, questionIndex, "answer");
  return replace(answers, questionIndex, { optionIndex, note: answer.note, accepted: false });
}

/** Set the words on question `questionIndex`, keeping its option. */
export function setNote(answers: Answers, questionIndex: number, note: string): Answers {
  const answer = at(answers, questionIndex, "answer");
  // Words on an accepted answer make it the person's own (an accepted answer has none).
  const accepted = answer.accepted && note.trim() === "";
  return replace(answers, questionIndex, { optionIndex: answer.optionIndex, note, accepted });
}

/** An answer counts once it has an option, the person's words, or both. */
export function isAnswered(answer: Answer): boolean {
  return answer.optionIndex !== null || answer.note.trim() !== "";
}

/** Accept the rest: every unanswered question takes option 0, its recommendation, marked accepted. */
export function acceptRest(answers: Answers): Answers {
  return answers.map((answer) =>
    isAnswered(answer) ? answer : { optionIndex: 0, note: "", accepted: true },
  );
}

export function answeredCount(answers: Answers): number {
  return answers.filter(isAnswered).length;
}

/** Complete once every question is answered; **Send answers** is enabled only then. */
export function isComplete(answers: Answers): boolean {
  return answers.length > 0 && answeredCount(answers) === answers.length;
}

/** The `questionRound.submit` answers: words trimmed; refuses an incomplete round. */
export function submission(answers: Answers): Answers {
  if (!isComplete(answers)) {
    throw new Error("A round is sent only once every question is answered");
  }
  return answers.map((answer) => ({
    optionIndex: answer.optionIndex,
    note: answer.note.trim(),
    accepted: answer.accepted,
  }));
}

/** N in the hint `1–N choose`: the most options on any question. */
export function mostOptions(questions: readonly Question[]): number {
  if (questions.length === 0) {
    throw new Error("A round has at least one question");
  }
  return Math.max(...questions.map((question) => question.options.length));
}

/** Where a key was pressed inside the round. */
export type KeyTarget = "textarea" | "radio" | "other";

export interface KeyPress {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  target: KeyTarget;
}

/** What a key does; null leaves it to the browser. */
export type KeyAction =
  | { kind: "move"; to: number }
  | { kind: "choose"; questionIndex: number; optionIndex: number; then: number }
  | { kind: "send" }
  | { kind: "leave-notes" };

/**
 * The round's keys: ↑/↓ move the active question; 1–N choose on it and advance; Escape
 * leaves the words; ⌘↵ or Ctrl↵ sends once complete. Inside the words only Escape and send act,
 * and arrows inside a radio group keep their default. Tab is the browser's own.
 */
export function keyAction(
  press: KeyPress,
  state: { questions: readonly Question[]; active: number; complete: boolean },
): KeyAction | null {
  const last = state.questions.length - 1;
  if (press.key === "Enter" && (press.metaKey || press.ctrlKey)) {
    return state.complete ? { kind: "send" } : null;
  }
  if (press.target === "textarea") {
    return press.key === "Escape" ? { kind: "leave-notes" } : null;
  }
  if (press.metaKey || press.ctrlKey) {
    return null;
  }
  if (press.target === "radio" && press.key.startsWith("Arrow")) {
    return null;
  }
  if (press.key === "ArrowDown") {
    return { kind: "move", to: Math.min(state.active + 1, last) };
  }
  if (press.key === "ArrowUp") {
    return { kind: "move", to: Math.max(state.active - 1, 0) };
  }
  if (/^[1-9]$/.test(press.key)) {
    const optionIndex = Number(press.key) - 1;
    const question = at(state.questions, state.active, "question");
    if (optionIndex >= question.options.length) {
      return null;
    }
    return {
      kind: "choose",
      questionIndex: state.active,
      optionIndex,
      then: Math.min(state.active + 1, last),
    };
  }
  return null;
}
