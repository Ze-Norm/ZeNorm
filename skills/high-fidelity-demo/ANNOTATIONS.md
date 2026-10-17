# Annotations

The demo's widget is how the user gives feedback: they click an element, write a note, and the note is pinned to that element by a CSS selector, a best-effort React component chain, and the text it contained. That is enough to find the code that renders it.

Reference for the widget the template ships. Read it when you work a round of notes. In a ZeNorm run, also follow [the shared integration reference](../zenorm-integration.md): register/link these notes through the supplied tools with the demo identity and revision. The template's local file transports feedback; the durable annotation and human-response records carry its workflow meaning. Preserve note identity, the user's words, target context, and resolution history. An agent's exercise of the widget is verification evidence, not human feedback or approval.

## Where the notes are

`annotations.json` in the demo root, written by the dev-only Vite plugin in `vite.config.ts` and served at `/__annotations` (`GET` reads, `POST` replaces).

```bash
# every open note, one per line
node -e 'for (const n of require("./annotations.json")) if (n.status === "open") console.log(`- [${n.target.component ?? n.target.tag}] ${n.note}`)'
```

The panel re-reads the file every four seconds and whenever the tab regains focus, so your edits appear without a reload. The widget posts its whole in-memory list on every user change, so your edit and the user's click inside the same four-second window lose one of them: re-read immediately before you write, and expect to re-apply after they have been annotating.

If the demo is served without the plugin (a static build, for example), the widget keeps notes in this browser only and the panel says so — ask the user for **Copy as Markdown** instead.

## The record

| Field | What it tells you |
| --- | --- |
| `note` | The user's words: feedback whose scope is resolved through discussion and the verdict. |
| `status` | `open` or `resolved`. |
| `url` | Path, query and hash of the page the note was written on. |
| `target.selector` | CSS selector that re-finds the element. `data-demo-id` shortens it. |
| `target.component` | React component chain, innermost first. The fastest route to the file. |
| `target.text` | Up to 120 characters of the element's text. |
| `target.rect`, `viewport` | Where it sat, and at what size. |
| `createdAt` | ISO timestamp; order rounds by it. |

## Working a round

1. Read the open notes, grouped by `target.component`.
2. Satisfy each one in the demo. A note about a fixture or a flow changes the fixture or the flow, not the widget.
3. Leave `status` alone — the user resolves the notes they are happy with, so the open count is the shared to-do list. List what you changed, link the revised artifact and relevant questions, then request another pass through the supplied interaction surface. A resolved note does not replace the final scoped demo verdict.
4. Change nothing else about the running demo: Vite hot-reloads on save.

A selector that no longer matches means the element moved or was renamed. "Locate" says so in the panel, and your reply should say which earlier note that affects.

## Inside the widget

The template wires this up; read these only to change the widget itself.

| File | Role |
| --- | --- |
| `AnnotationWidget.tsx` | Corner buttons, the picking overlay, the composer. |
| `AnnotationPanel.tsx` | The notes list, Locate, resolve, delete, Markdown copy. |
| `annotations.ts` | Element description, record creation, file and browser storage. |
| `useAnnotations.ts` | Loading, the poll, and the writes. |
| `Highlight.tsx` | The box drawn over a picked or located element. |

Everything the widget renders carries `data-annotation-ui`, which is how the picker ignores its own DOM. Put `data-demo-id="..."` on the smallest element you want annotated: it gives that element a short, stable selector, and the value must be unique on the page — a duplicate silently resolves to the first match, so Locate flashes the wrong element.
