import { cn } from "@/lib/utils";

/**
 * A box drawn over the page at a viewport-relative position. Used for the
 * element under the pointer, the element being annotated, and "Locate".
 */
export function Highlight({
  rect,
  label,
  tone = "picked",
}: {
  rect: DOMRect;
  label?: string | null;
  tone?: "picked" | "flash";
}) {
  return (
    <div
      data-annotation-ui=""
      className={cn(
        "pointer-events-none fixed z-[100] rounded-sm border-2",
        tone === "picked" ? "border-primary bg-primary/10" : "border-amber-500 bg-amber-400/20",
      )}
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
    >
      {label ? (
        <span className="absolute -top-5 left-0 max-w-64 truncate rounded-sm bg-primary px-1.5 py-0.5 font-mono text-[10px] text-primary-foreground">
          {label}
        </span>
      ) : null}
    </div>
  );
}
