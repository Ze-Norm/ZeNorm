import type {
  Answer,
  Answers,
  Question,
  QuestionRound as QuestionRoundRecord,
} from "@zenorm/contracts";
import { ArrowRight } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { AgentText } from "@/components/AgentText";
import { Micro } from "@/components/parts";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import {
  acceptRest,
  answeredCount,
  choose,
  initialAnswers,
  isAnswered,
  isComplete,
  keyAction,
  mostOptions,
  setNote,
  submission,
  type KeyTarget,
} from "./answer-state.ts";
import { roundFooter } from "./round-footer.ts";
import { at, RoundsRecord, useSubmitAnswers } from "./shared.tsx";

function questionNumber(index: number): string {
  return String(index + 1).padStart(2, "0");
}

function keyTarget(element: EventTarget): KeyTarget {
  if (element instanceof HTMLTextAreaElement) {
    return "textarea";
  }
  if (element instanceof HTMLElement && element.getAttribute("role") === "radio") {
    return "radio";
  }
  return "other";
}

/**
 * The open question round (spec D10), for the map round and every waypoint round: earlier rounds
 * in the record form, the agent's intro, one card per question and the sticky footer. The page
 * renders the head (eyebrow, title, question) above Wayfinding's index, as every stage's head.
 * Keys follow `keyAction`. The submit is this round's own, so a later round (a new key) is never
 * held by an earlier round's send or shows its refusal.
 */
export function QuestionRound({
  round,
  earlier,
  heldBy,
}: {
  round: QuestionRoundRecord;
  earlier: readonly QuestionRoundRecord[];
  /** Why the answers cannot be sent yet (an undecided split offer), or null when they can. */
  heldBy: string | null;
}) {
  const { submit, submitting, refusal } = useSubmitAnswers();
  const [answers, setAnswers] = useState<Answers>(() => initialAnswers(round.questions));
  const [active, setActive] = useState(0);
  const article = useRef<HTMLElement>(null);
  const cards = useRef<(HTMLLIElement | null)[]>([]);
  const answered = answeredCount(answers);
  const complete = isComplete(answers);

  useEffect(() => {
    article.current?.focus({ preventScroll: true });
  }, []);

  if (round.status !== "pending") {
    throw new Error(`Round ${round.id} is ${round.status}, not open`);
  }

  function send() {
    if (submitting || heldBy !== null) {
      return;
    }
    submit(round.id, submission(answers));
  }

  function moveTo(index: number) {
    setActive(index);
    cards.current[index]?.scrollIntoView({ block: "nearest" });
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    const action = keyAction(
      {
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        target: keyTarget(event.target),
      },
      { questions: round.questions, active, complete },
    );
    if (action === null) {
      return;
    }
    event.preventDefault();
    switch (action.kind) {
      case "send":
        send();
        return;
      case "leave-notes":
        article.current?.focus();
        return;
      case "move":
        moveTo(action.to);
        return;
      case "choose":
        setAnswers(choose(round.questions, answers, action.questionIndex, action.optionIndex));
        moveTo(action.then);
        return;
    }
  }

  const keyHint = `↑/↓ question · 1–${String(mostOptions(round.questions))} choose · tab notes · ⌘↵ send`;

  const footerLine = roundFooter(round);

  return (
    <article
      ref={article}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="grid grid-cols-[minmax(0,1fr)] gap-5 outline-none"
    >
      {earlier.length > 0 && <RoundsRecord rounds={earlier} resolved={false} />}

      <div className="grid gap-1 border-l-2 border-agent bg-card px-3.5 py-2.5">
        <Micro className="text-agent-fg">Agent · round {round.number}</Micro>
        <p className="text-[14px]">{round.intro}</p>
      </div>

      <form
        aria-label="Question round"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
        className="grid gap-5"
      >
        <ol className="grid gap-3">
          {round.questions.map((question, questionIndex) => (
            <OpenQuestion
              key={questionIndex}
              ref={(element) => {
                cards.current[questionIndex] = element;
              }}
              question={question}
              questionIndex={questionIndex}
              answer={at(answers, questionIndex, "answer")}
              active={active === questionIndex}
              onActive={() => {
                setActive(questionIndex);
              }}
              onChoose={(optionIndex) => {
                setAnswers(choose(round.questions, answers, questionIndex, optionIndex));
              }}
              onNote={(note) => {
                setAnswers(setNote(answers, questionIndex, note));
              }}
            />
          ))}
        </ol>
        {refusal}
        {/* The footer floats over the cards while they scroll; the shadow reads as that layer, and
            its top margin keeps the last card clear of it once the page is scrolled to the end
            (UX audit E4). */}
        <div className="sticky bottom-0 z-20 mt-3 grid gap-1.5 border-t border-hair-strong bg-background py-3 shadow-[0_-12px_16px_-12px_rgba(26,26,26,0.18)]">
          <div className="flex flex-wrap items-center gap-4">
            <span className="text-[13px] text-muted-foreground">
              {answered} of {round.questions.length} answered
            </span>
            <span className="flex-1" />
            <Button
              type="button"
              variant="link"
              disabled={complete}
              onClick={() => {
                setAnswers(acceptRest(answers));
                // The button disables itself; keep the round's keys working.
                article.current?.focus();
              }}
            >
              Accept the recommendations for the rest
            </Button>
            <Button type="submit" disabled={!complete || submitting || heldBy !== null}>
              Send answers <ArrowRight />
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
            {heldBy === null ? (
              <span>{footerLine}</span>
            ) : (
              <span className="text-primary">{heldBy}</span>
            )}
            <span className="flex-1" />
            <span className="font-mono text-[11px] text-faint max-sm:hidden pointer-coarse:hidden">
              {keyHint}
            </span>
          </div>
        </div>
      </form>
    </article>
  );
}

function OpenQuestion({
  ref,
  question,
  questionIndex,
  answer,
  active,
  onActive,
  onChoose,
  onNote,
}: {
  ref: (element: HTMLLIElement | null) => void;
  question: Question;
  questionIndex: number;
  answer: Answer;
  active: boolean;
  onActive: () => void;
  onChoose: (optionIndex: number) => void;
  onNote: (note: string) => void;
}) {
  const [writing, setWriting] = useState(false);
  const idPrefix = `question-${String(questionIndex)}`;
  const textId = `${idPrefix}-text`;
  const noteId = `${idPrefix}-note`;

  return (
    <Card asChild className={cn("grid gap-3 p-4", active && "border-ink-line")}>
      <li
        ref={ref}
        aria-labelledby={textId}
        aria-current={active ? "step" : undefined}
        onClick={onActive}
        onFocus={onActive}
      >
        <div className="grid gap-1">
          <div className="flex items-center gap-2.5">
            <span className="font-mono text-[11px] text-faint">
              {questionNumber(questionIndex)}
            </span>
            <Micro className="flex-1">{question.topic}</Micro>
            {answer.accepted ? (
              <Badge variant="secondary">recommendation accepted</Badge>
            ) : (
              isAnswered(answer) && <Badge variant="ok">answered</Badge>
            )}
          </div>
          <h3
            id={textId}
            className="font-display text-[16px] leading-snug font-semibold tracking-[-0.015em]"
          >
            <AgentText text={question.text} />
          </h3>
        </div>

        <RadioGroup
          aria-labelledby={textId}
          value={answer.optionIndex === null ? "" : String(answer.optionIndex)}
          onValueChange={(value) => {
            onChoose(Number(value));
          }}
          className="gap-2"
        >
          {question.options.map((option, optionIndex) => {
            const optionId = `${idPrefix}-option-${String(optionIndex)}`;
            const labelId = `${optionId}-label`;
            const detailId = `${optionId}-detail`;
            const selected = answer.optionIndex === optionIndex;
            return (
              <div
                key={optionId}
                className={cn(
                  "relative grid grid-cols-[16px_1fr_auto] items-start gap-x-3 gap-y-1 border px-3.5 py-3",
                  selected
                    ? "border-primary bg-primary-soft"
                    : "border-border hover:border-hair-strong hover:bg-secondary",
                )}
              >
                <RadioGroupItem
                  id={optionId}
                  value={String(optionIndex)}
                  aria-labelledby={labelId}
                  aria-describedby={detailId}
                  className="relative z-10 mt-[3px] border-ink-line"
                />
                <span className="flex flex-wrap items-center gap-2">
                  {/* The label covers the option, so a click anywhere chooses it; the radio sits above it. */}
                  <Label
                    id={labelId}
                    htmlFor={optionId}
                    className="cursor-pointer text-[14.5px] font-semibold after:absolute after:inset-0"
                  >
                    <AgentText text={option.label} />
                  </Label>
                  {optionIndex === 0 && <Badge variant="soft">recommended</Badge>}
                </span>
                <span
                  aria-hidden
                  className={cn(
                    "font-mono text-[11px]",
                    /* On the chosen option's signal fill, faint falls short of 4.5:1; muted holds it. */
                    selected ? "text-muted-foreground" : "text-faint",
                  )}
                >
                  {optionIndex + 1}
                </span>
                <p id={detailId} className="col-start-2 text-[13px] text-muted-foreground">
                  <AgentText text={option.detail} />
                </p>
              </div>
            );
          })}
        </RadioGroup>

        {writing || answer.note !== "" ? (
          <div className="grid gap-1.5">
            <Label htmlFor={noteId} className="sr-only">
              Your words: {question.topic}
            </Label>
            <Textarea
              id={noteId}
              autoFocus={writing && answer.note === ""}
              value={answer.note}
              onChange={(event) => {
                onNote(event.target.value);
              }}
              onBlur={() => {
                setWriting(false);
              }}
              rows={1}
              placeholder="Add to your choice, or answer in your own words instead"
              className="min-h-9 resize-none text-[13px]"
            />
          </div>
        ) : (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto w-fit p-0 text-xs text-muted-foreground"
            onClick={() => {
              setWriting(true);
            }}
          >
            Add your own words…
          </Button>
        )}
      </li>
    </Card>
  );
}
