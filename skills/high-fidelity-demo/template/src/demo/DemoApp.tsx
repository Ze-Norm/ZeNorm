import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fixtures, type Fixture } from "./fixtures";

/**
 * The placeholder surface. Delete it and build the demo here: every control
 * responds, nothing reaches a server, and every record is a fixture.
 */
export function DemoApp() {
  const [items, setItems] = React.useState<Fixture[]>(fixtures);
  const [draft, setDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  const add = () => {
    const title = draft.trim();
    if (!title) return;
    setSaving(true);
    // Pretended latency: the wait itself may be part of what is being confirmed.
    window.setTimeout(() => {
      setItems((current) => [
        { id: `EX-${String(current.length + 4).padStart(2, "0")}`, title, owner: "You", status: "draft" },
        ...current,
      ]);
      setDraft("");
      setSaving(false);
    }, 400);
  };

  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <p className="text-sm text-muted-foreground">
        This screen is a placeholder. It exists so the annotation widget has something to sit on — replace it with
        the surface the demo is deciding.
      </p>

      <section data-demo-id="new-example" className="mt-6 rounded-lg border border-border bg-card p-4">
        <Label htmlFor="new-title">Add an example</Label>
        <div className="mt-2 flex gap-2">
          <Input
            id="new-title"
            value={draft}
            placeholder="What should this example cover?"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") add();
            }}
          />
          <Button onClick={add} disabled={saving || !draft.trim()}>
            {saving ? "Saving..." : "Add"}
          </Button>
        </div>
      </section>

      <ul data-demo-id="example-list" className="mt-6 space-y-2">
        {items.map((item) => (
          <li
            key={item.id}
            className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
          >
            <span className="font-mono text-[11px] text-muted-foreground">{item.id}</span>
            <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>
            <span className="text-xs text-muted-foreground">{item.owner}</span>
            <Badge variant={item.status === "approved" ? "default" : "secondary"}>{item.status}</Badge>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setItems((current) => current.filter((candidate) => candidate.id !== item.id))
              }
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
    </main>
  );
}
