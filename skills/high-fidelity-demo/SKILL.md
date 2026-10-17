---
name: high-fidelity-demo
description: Build a high-fidelity demo of a prototype the user already picked, with simulated functionality, so they can confirm the approach before a spec and tickets. Use when a direction is chosen and the user wants to click through it, or says "build the demo", "high-fidelity demo", "demo it", or "final checkpoint before the spec".
---

Read [ZeNorm integration](../zenorm-integration.md) for authoritative records, human input, revisions, and runtime responsibilities.

# High-fidelity demo

A prototype answers a question. A **demo** confirms that the answer is worth building. It carries the selected direction at full fidelity with **simulated** behavior — fixture data, in-memory state, pretended latency — so the user clicks the real thing and changes it while changing it is still cheap.

A demo is throwaway, like the prototype it came from: no tests, no error handling past runnable, no backend. It ends in a **verdict**, not in code.

## The loop

### 1. Take the selection

Read what the previous sessions settled: the prototype the user selected, the revision it was selected at — where the repo records only a branch and a commit, that branch and commit *are* the revision — and the decision ticket behind it. Take the prototype branch, the ticket body, the screenshots, whatever the thread left. If no direction is chosen yet, stop and run `/prototype` (a UI question) or `/grilling` (a scope or logic question) first.

**Done when** the selected prototype, revision, and scoped approach are identifiable and covered by recorded human agreement. Reuse an existing selection; request clarification only for a missing or changed selection.

### 2. Agree the surface

List the screens and flows the demo must carry: every decision the coming spec will lean on, and nothing else. One or two screens is the usual size — the smallest surface that exercises the decisions. Reuse the recorded surface agreement where it still covers the work; confirm only missing or changed scope before building those additions. This list is the top of the demo README, which you write once, here, and keep in step 5.

**Done when** the user has agreed the list, and every item on it is either simulated by the demo or explicitly out.

### 3. Copy the template and build

Copy this skill's `template/` — React 19, Vite, Tailwind v4 and shadcn, with the annotation widget already wired — to wherever the repo keeps throwaway UI, beside the prototype it came from:

```bash
cp -R "<skill-dir>/template" <repo>/<throwaway-home>/<demo-name>
```

Then `pnpm install && pnpm dev`. Replace `src/demo/` with the real surface, set `DEMO_TITLE` in `src/App.tsx`, and rename the package in `package.json`.

Simulate behind the interface: fixtures in `src/demo/fixtures.ts`, state in memory, a `setTimeout` where the wait is part of what is being confirmed. Every product control responds from that state; the template's only persistence is its annotation widget. Register the demo artifact/revision and its source prototype through the supplied tools, separately from simulated product behavior. Mark pretended behavior wherever the user could mistake it for working software.

**Done when** every screen on the agreed list is reachable from the running dev URL, and every control on them visibly responds.

### 4. Iterate on annotations

Send the user to the demo and let them annotate instead of describing: the widget pins each note to the exact element they clicked and writes it to `annotations.json`. Read that file, satisfy the open notes, then ask for another pass. [ANNOTATIONS.md](ANNOTATIONS.md) has the record fields, commands, and the connection to ZeNorm's durable records. Link annotations and questions to the demo identity and the revision being discussed; preserve the user's words and response history.

Check the loop yourself before you hand over the link: pick an element and save a note, confirm it lands in `annotations.json` with a `selector` and a `component`, edit the file on disk and confirm the open panel picks the change up without a reload, and watch the console for errors.

A note asking for new scope, or two notes that contradict, goes back to the user through a question round. Round submission lets discussion continue; the final demo verdict remains separate.

**Done when** no open notes remain — the user resolves each one they are happy with — and they say the demo is what they want built.

### 5. Record the verdict and hand off

Rewrite the demo README: the surface list, what is simulated, the open questions, and the standing verdict — who approved what, at which revision, and what stayed unresolved. Commit the demo off main, on the same throwaway branch as its prototype, and link it from the prototype's decision ticket. Publish the artifact revision and annotation references through the supplied tools, and link the actual final human verdict. Stop the dev server.

Then use [To Spec](../to-spec/SKILL.md) with the approved scope. Carry the demo and annotations alongside the other full governing decisions, existing contracts, testing agreements, and work evidence. A later annotation or edit does not expand an earlier verdict.

**Done when** the demo, README, and notes are recoverable at the recorded revision; annotations, questions, and the scoped human verdict are linked; and the synthesis handoff carries those references and any unresolved boundaries.
