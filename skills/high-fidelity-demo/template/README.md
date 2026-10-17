# High-fidelity demo

Throwaway demo of the approach the prototype chose. Simulated functionality only: fixture data, in-memory state, no backend, no tests. It exists to confirm the approach before a spec and its tickets commit to it.

```bash
pnpm install
pnpm dev
```

## Annotate it

Click **Annotate** in the bottom-right corner, then click any element and write what should change there. **Notes** lists everything collected, **Locate** flashes the element on the page, and **Copy as Markdown** puts the notes into the chat. Notes are saved to `annotations.json` in this directory — that file is what the agent reads between rounds.

## Layout

| Path | What it is |
| --- | --- |
| `src/demo/` | The demo surface. Replace it. |
| `src/App.tsx` | Shell: demo banner, the surface, the annotation widget. Set `DEMO_TITLE`. |
| `src/components/annotations/` | The widget. Used as-is. |
| `src/components/ui/` | shadcn primitives — badge, button, collapsible, dialog, input, label, progress, radio-group, scroll-area, separator, tabs, textarea and tooltip. `pnpm dlx shadcn@latest add <name>` fetches any other (needs network); check the generated file imports `cn` from `@/lib/utils`, since the CLI has emitted `from "cn"` and installed an unrelated `cn` package. |
| `src/index.css` | ZeNorm's editorial theme on shadcn tokens: warm paper, green-grey ink, blue `primary`, plus `ok`/`ok-soft` (resolved, approved) and `warn`/`warn-soft` (held, needs you). `font-sans` is Instrument Sans, `font-serif` Newsreader, `font-mono` JetBrains Mono, loaded locally in `src/main.tsx`. |
| `annotations.json` | The notes, written by the dev server. |
| `vite.config.ts` | Serves and writes `annotations.json` at `/__annotations`. |

Replace this README with the agreed surface list, what is simulated, and the standing verdict.
