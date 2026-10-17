import * as React from "react";
import { AnnotationWidget } from "@/components/annotations/AnnotationWidget";
import { DemoApp } from "@/demo/DemoApp";

/** Replace with the thing this demo is deciding. Also the browser tab title. */
const DEMO_TITLE = "Untitled high-fidelity demo";

export function App() {
  React.useEffect(() => {
    document.title = DEMO_TITLE;
  }, []);

  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-50 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-card px-4 py-2">
        <span className="rounded-sm bg-foreground px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wider text-background uppercase">
          Demo
        </span>
        <span className="text-sm font-medium">{DEMO_TITLE}</span>
        <span className="font-mono text-[10px] text-muted-foreground">
          simulated · fixture data · no backend
        </span>
      </header>

      <DemoApp />

      <AnnotationWidget />
    </div>
  );
}
