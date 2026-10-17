import type { HatchStage, SendHatchMessageError } from "@zenorm/contracts";
import { ChevronRight, MessageSquare } from "lucide-react";
import { useEffect, useRef } from "react";

import { useHatch } from "@/components/hatch/HatchProvider";
import { RefusalAlert } from "@/components/RefusalAlert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Textarea } from "@/components/ui/textarea";
import { canSend, composerKeyAction } from "@/lib/hatch";
import { stageName } from "@/lib/map";
import { useSendHatchMessage } from "@/lib/queries";
import type { AccessDeniedError } from "@zenorm/contracts";
import { accessDeniedSentence } from "@/lib/access";

/** The sentence shown for a `hatch.send` refusal, chosen by its code. */
function sendRefusalMessage(error: SendHatchMessageError | AccessDeniedError): string {
  if (error.code === "access_denied") return accessDeniedSentence(error);
  switch (error.code) {
    case "map_not_found":
      return "This map no longer exists.";
    case "hatch_message_empty":
      return "Write something to send.";
    case "spec_not_found":
      return "This map wrote no such spec.";
    case "spec_waiting":
      // The refusal stays (L220); the sentence says the note was not saved (S8b-16, N-3), as the
      // hatch run's reply on a held waited spec does (L221).
      return "Another map holds this spec, so your note was not saved. This map waits on the spec, and its change is written as the next revision once the spec is free.";
  }
}

/**
 * The escape hatch (slice 7b D7, the demo's `ActivityLog.tsx`): under the stream, a closed row;
 * open, the contract line, the composer (Enter sends, Shift+Enter a new line) and Send, disabled
 * while the text is blank. A message names the stage on screen and `specNumber`, the spec on
 * screen (the demo's `aboutSpec`).
 */
export function HatchComposer({
  mapId,
  stage,
  specNumber,
}: {
  mapId: string;
  stage: HatchStage;
  specNumber: number | null;
}) {
  const hatch = useHatch();
  const send = useSendHatchMessage();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const { open, focusRequest } = hatch;

  useEffect(() => {
    const field = textarea.current;
    if (!open || field === null) {
      return;
    }
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, [open, focusRequest]);

  const submit = () => {
    if (!canSend(hatch.text) || send.isPending) {
      return;
    }
    send.mutate(
      { mapId, stage, specNumber, text: hatch.text.trim() },
      { onSuccess: hatch.sentMessage },
    );
  };

  return (
    <Collapsible open={open} onOpenChange={hatch.setOpen} className="border-t border-border pb-14">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-[13px] hover:bg-secondary">
        <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="flex-1 text-muted-foreground group-data-[state=open]:text-foreground">
          Need something the stages don't offer? Tell the agent
        </span>
        <ChevronRight
          className="size-3.5 shrink-0 text-faint transition-transform group-data-[state=open]:rotate-90"
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-2 px-3 pb-3">
        <p className="text-xs leading-snug text-muted-foreground">
          Ask anything, or ask for any change: reopen a decision, revise the spec, redo the tickets.
          The agent answers here and says what it changed; the change lands on the stage as a new
          round, revision or ticket set, which you review there. Answering, approving and starting
          delivery stay on the stage pages.
        </p>
        <Textarea
          ref={textarea}
          aria-label="Message to the agent"
          autoFocus
          value={hatch.text}
          onChange={(event) => {
            hatch.setText(event.target.value);
          }}
          onKeyDown={(event) => {
            if (composerKeyAction(event) === "send") {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={`About ${stageName(stage)}…`}
          className="min-h-16 resize-none bg-background text-[13px]"
        />
        <div className="flex items-center gap-2">
          <span className="flex-1" />
          <span className="font-mono text-[11px] text-faint max-sm:hidden pointer-coarse:hidden">
            ↵ send · ⇧↵ newline
          </span>
          <Button
            variant="ink"
            size="sm"
            onClick={submit}
            disabled={!canSend(hatch.text) || send.isPending}
          >
            Send
          </Button>
        </div>
        {send.error !== null && (
          <RefusalAlert
            error={send.error}
            sentence={sendRefusalMessage}
            title="Could not send the message"
            showMessage={false}
          />
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
