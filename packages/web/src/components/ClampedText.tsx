import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/** The clamp per line count, as literals so Tailwind sees each class. */
const CLAMP: Record<3 | 4 | 6, string> = {
  3: "group-data-[state=closed]/clamped:line-clamp-3",
  4: "group-data-[state=closed]/clamped:line-clamp-4",
  6: "group-data-[state=closed]/clamped:line-clamp-6",
};

/**
 * Text that can run long (a person's idea, a note, a reason, an excerpt), shown where it is context
 * rather than the page's content: clamped to `lines`, with Show more and Show less once it runs past
 * them. Whether it runs past is measured, again on every resize and every font load (a webfont
 * swapping in reflows the text without resizing the clamped box).
 */
export function ClampedText({
  as: Element,
  lines,
  className,
  children,
  ...rest
}: {
  as: "p" | "div" | "blockquote";
  lines: 3 | 4 | 6;
  className?: string;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, "children" | "className">) {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const text = useRef<HTMLParagraphElement & HTMLDivElement & HTMLQuoteElement>(null);
  const id = useId();

  useLayoutEffect(() => {
    const element = text.current;
    if (element === null || open) {
      return;
    }
    const measure = () => {
      setOverflows(element.scrollHeight > element.clientHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    document.fonts.addEventListener("loadingdone", measure);
    void document.fonts.ready.then(measure);
    return () => {
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", measure);
    };
  }, [children, open]);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="group/clamped grid justify-items-start gap-0.5"
    >
      <Element
        {...rest}
        ref={text}
        id={id}
        className={cn("justify-self-stretch", className, CLAMP[lines])}
      >
        {children}
      </Element>
      {(overflows || open) && (
        <CollapsibleTrigger asChild>
          <Button variant="link" size="sm" aria-controls={id} className="h-auto py-0">
            {open ? "Show less" : "Show more"}
          </Button>
        </CollapsibleTrigger>
      )}
    </Collapsible>
  );
}
