---
name: code-review
description: "Review a delivery run's committed change from its base commit along two axes: Standards (does the code follow this repo's documented coding standards?) and Spec (does the code match the governing spec and tickets?). Runs both reviews in parallel sub-agents and reports them side by side."
---

Two-axis review of the committed changes from the review's base commit:

- **Standards**: does the code conform to this repo's documented coding standards?
- **Spec**: does the code faithfully implement the governing spec and tickets?

Both axes run as **parallel sub-agents** so they don't pollute each other's context, then this skill aggregates their findings.

The assignment names the governing spec and tickets files, the base commit, and the final commit or `HEAD`; it may also name the diff file and list the changed files. Read those inputs from the files it names; nothing else replaces them.

## Process

### 1. Pin the fixed point

Use the base and final commits the assignment names. Verify the refs, then capture `git diff <base> <final>` and the commit list `git log <base>..<final>`. If the diff is empty, report no changes to review. Both sub-agents get the same base, final commit and file scope.

### 2. Identify the spec source

The spec and tickets files the assignment names are the governing contract. Read each in full: the clauses, their criteria, and each ticket's testing, pointer and Out of scope lines. A missing or unreadable governing file leaves the Spec review incomplete; do not report a pass.

### 3. Identify the standards sources

Anything in the repo that documents how code should be written, such as `CODING_STANDARDS.md` or `CONTRIBUTING.md`.

On top of whatever the repo documents, the Standards axis always carries the **smell baseline** below: a fixed set of Fowler code smells (_Refactoring_, ch.3) that applies even when a repo documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation. Like any standard here, skip anything tooling already enforces.

Each smell reads _what it is_ → _how to fix_; match it against the diff:

- **Mysterious Name**: a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code**: the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy**: a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps**: the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession**: a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches**: the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery**: one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change**: one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality**: abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains**: long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man**: a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest**: a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

### 4. Spawn both sub-agents in parallel

Start both in one turn, in the foreground, and wait for both reports before step 5. Never end your turn or return your report while a sub-agent is still running: a review returned before its sub-agents finish has no findings, and whoever started you has to run it again.

Each sub-agent's prompt carries the pinned diff command, commit list and final commit, plus the diff file and changed-files list when the assignment supplies them. Tell each sub-agent to read the whole diff before judging anything, then to open a changed file whenever its hunk is not enough to judge it (tests and build or manifest files included).

**Standards sub-agent prompt** adds:

- The list of standards-source files you found in step 3, **plus the smell baseline from step 3** pasted in full (the sub-agent has no other access to it).
- The brief: "Report, per file/hunk where relevant, (a) every place the diff violates a documented standard: cite the standard (file + the rule); and (b) any baseline smell you spot: name it and quote the hunk. Distinguish hard violations from judgement calls: documented-standard breaches can be hard, but baseline smells are always judgement calls, and a documented repo standard overrides the baseline. Skip anything tooling enforces. Under 400 words."

**Spec sub-agent prompt** adds:

- The paths of the governing spec and tickets files, to read in full: their clauses, criteria, testing lines and exclusions.
- The brief: "Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong; (d) code that satisfies a decision's letter only through a workaround with a real cost (such as hand-written shims for an excluded dependency), naming the decision so it can be revisited; (e) any state, status value, recovery path or stored copy of existing state that the diff adds and the spec does not contain, naming the spec section that would have had to contain it. Quote the spec line for each finding. Under 400 words."

### 5. Draw the completion boundary

Separate blocking defects from optional suggestions within each axis. A blocker keeps the change from meeting the governing contract or violates a documented mandatory standard; cite the concrete requirement and evidence. Judge a Spec finding under (e) as scope creep. Baseline smells remain suggestions unless they establish such a defect. PASS can include optional suggestions. Do not turn a passing review into another cleanup cycle.

### 6. Aggregate

Return both reports in the host's output format with their reviewed base and final commit, governing references, findings, and evidence locations; where the host gives none, present them under `## Standards` and `## Spec` headings, verbatim or lightly cleaned. Do **not** merge or rerank findings, because the two axes are deliberately separate (see _Why two axes_).

End with a one-line summary: total findings per axis, and the worst issue _within each axis_ (if any). Don't pick a single winner across axes: that's the reranking the separation exists to prevent.

## Why two axes

A change can pass one axis and fail the other:

- Code that follows every standard but implements the wrong thing → **Standards pass, Spec fail.**
- Code that does exactly what the issue asked but breaks the project's conventions → **Spec pass, Standards fail.**

Reporting them separately stops one axis from masking the other.
