import type { Question } from "@zenorm/contracts";
import { describe, expect, it } from "vitest";

import {
  acceptRest,
  answeredCount,
  choose,
  initialAnswers,
  isComplete,
  keyAction,
  mostOptions,
  setNote,
  submission,
  type KeyPress,
} from "./answer-state.ts";

function question(options: number): Question {
  return {
    topic: "Topic",
    text: "Which?",
    options: Array.from({ length: options }, (_, i) => ({
      label: `Option ${String(i + 1)}`,
      detail: "Detail",
    })),
  };
}

const questions = [question(2), question(3), question(2)];

function press(key: string, extra: Partial<KeyPress> = {}): KeyPress {
  return { key, metaKey: false, ctrlKey: false, target: "other", ...extra };
}

describe("choose and words", () => {
  it("starts with every question unanswered", () => {
    const answers = initialAnswers(questions);
    expect(answers).toEqual([
      { optionIndex: null, note: "", accepted: false },
      { optionIndex: null, note: "", accepted: false },
      { optionIndex: null, note: "", accepted: false },
    ]);
    expect(answeredCount(answers)).toBe(0);
  });

  it("chooses an option and keeps the words", () => {
    let answers = setNote(initialAnswers(questions), 1, "mine");
    answers = choose(questions, answers, 1, 2);
    expect(answers[1]).toEqual({ optionIndex: 2, note: "mine", accepted: false });
    expect(answeredCount(answers)).toBe(1);
  });

  it("counts words alone as an answer, and blank words as none", () => {
    expect(answeredCount(setNote(initialAnswers(questions), 0, "only words"))).toBe(1);
    expect(answeredCount(setNote(initialAnswers(questions), 0, "   "))).toBe(0);
  });

  it("refuses an option or question that does not exist", () => {
    expect(() => choose(questions, initialAnswers(questions), 0, 2)).toThrow();
    expect(() => choose(questions, initialAnswers(questions), 3, 0)).toThrow();
  });
});

describe("Accept the rest", () => {
  it("fills only unanswered questions with option 0, accepted", () => {
    const answers = acceptRest(choose(questions, initialAnswers(questions), 1, 1));
    expect(answers).toEqual([
      { optionIndex: 0, note: "", accepted: true },
      { optionIndex: 1, note: "", accepted: false },
      { optionIndex: 0, note: "", accepted: true },
    ]);
    expect(isComplete(answers)).toBe(true);
  });

  it("stays editable: choosing again or adding words makes the answer the person's own", () => {
    const accepted = acceptRest(initialAnswers(questions));
    expect(choose(questions, accepted, 0, 1)[0]).toEqual({
      optionIndex: 1,
      note: "",
      accepted: false,
    });
    expect(choose(questions, accepted, 0, 0)[0]?.accepted).toBe(false);
    expect(setNote(accepted, 0, "and more")[0]).toEqual({
      optionIndex: 0,
      note: "and more",
      accepted: false,
    });
    expect(setNote(accepted, 0, "")[0]?.accepted).toBe(true);
  });
});

describe("completeness and submission", () => {
  it("is complete only once every question is answered", () => {
    let answers = initialAnswers(questions);
    expect(isComplete(answers)).toBe(false);
    answers = choose(questions, answers, 0, 0);
    answers = setNote(answers, 1, "words");
    expect(isComplete(answers)).toBe(false);
    answers = choose(questions, answers, 2, 1);
    expect(isComplete(answers)).toBe(true);
  });

  it("submits one { optionIndex, note, accepted } per question, words trimmed", () => {
    let answers = initialAnswers(questions);
    answers = setNote(answers, 1, "  my words  ");
    answers = choose(questions, answers, 2, 1);
    answers = acceptRest(answers);
    expect(submission(answers)).toEqual([
      { optionIndex: 0, note: "", accepted: true },
      { optionIndex: null, note: "my words", accepted: false },
      { optionIndex: 1, note: "", accepted: false },
    ]);
  });

  it("refuses to submit an incomplete round", () => {
    expect(() => submission(initialAnswers(questions))).toThrow();
  });
});

describe("key mapping", () => {
  const state = { questions, active: 1, complete: false };

  it("moves the active question with ↑/↓, clamped", () => {
    expect(keyAction(press("ArrowDown"), state)).toEqual({ kind: "move", to: 2 });
    expect(keyAction(press("ArrowUp"), state)).toEqual({ kind: "move", to: 0 });
    expect(keyAction(press("ArrowDown"), { ...state, active: 2 })).toEqual({
      kind: "move",
      to: 2,
    });
    expect(keyAction(press("ArrowUp"), { ...state, active: 0 })).toEqual({ kind: "move", to: 0 });
  });

  it("chooses 1–N on the active question and advances", () => {
    expect(keyAction(press("3"), state)).toEqual({
      kind: "choose",
      questionIndex: 1,
      optionIndex: 2,
      then: 2,
    });
    expect(keyAction(press("1"), { ...state, active: 2 })).toEqual({
      kind: "choose",
      questionIndex: 2,
      optionIndex: 0,
      then: 2,
    });
  });

  it("ignores a number past the active question's options", () => {
    expect(keyAction(press("3"), { ...state, active: 0 })).toBeNull();
    expect(keyAction(press("0"), state)).toBeNull();
  });

  it("sends with ⌘↵ or Ctrl↵ only once complete, from anywhere", () => {
    expect(keyAction(press("Enter", { metaKey: true }), state)).toBeNull();
    expect(keyAction(press("Enter", { metaKey: true }), { ...state, complete: true })).toEqual({
      kind: "send",
    });
    expect(
      keyAction(press("Enter", { ctrlKey: true, target: "textarea" }), {
        ...state,
        complete: true,
      }),
    ).toEqual({ kind: "send" });
    expect(keyAction(press("Enter"), { ...state, complete: true })).toBeNull();
  });

  it("leaves the words with Escape and types everything else", () => {
    const inNotes = { target: "textarea" } as const;
    expect(keyAction(press("Escape", inNotes), state)).toEqual({ kind: "leave-notes" });
    expect(keyAction(press("1", inNotes), state)).toBeNull();
    expect(keyAction(press("ArrowDown", inNotes), state)).toBeNull();
  });

  it("keeps the arrows' default inside a radio group, but numbers still choose", () => {
    const onRadio = { target: "radio" } as const;
    expect(keyAction(press("ArrowDown", onRadio), state)).toBeNull();
    expect(keyAction(press("ArrowUp", onRadio), state)).toBeNull();
    expect(keyAction(press("2", onRadio), state)).toEqual({
      kind: "choose",
      questionIndex: 1,
      optionIndex: 1,
      then: 2,
    });
  });

  it("leaves Tab to the browser", () => {
    expect(keyAction(press("Tab"), state)).toBeNull();
  });

  it("hints N as the most options on any question", () => {
    expect(mostOptions(questions)).toBe(3);
  });
});
