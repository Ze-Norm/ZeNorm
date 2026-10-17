---
name: implement-spec
description: "Implement a specification's ticket set in code, in the run worktree ZeNorm created for a delivery run."
---

You have been provided a spec and its tickets, describing how to implement the spec. ZeNorm runs you as one delivery run's orchestrator session.

The goal is the entire spec implemented on a single branch: the **run branch**, which ZeNorm already created, checked out in the **run worktree**, which is your working directory. ZeNorm verifies, checks and reviews the result itself after you end, and the person merges it. You create no branch of your own beyond the implementer branches below, open no pull request, and push nothing.

The tickets are not a list of steps. They are a **task graph** with blocking relationships between them. This means there is always a **frontier** of tickets which are ready to be grabbed: every ticket whose blockers are all merged into the run branch. Run an **implementer subagent** in the background for every ticket on the frontier, for maximum concurrency.

Communication to and from subagents should be sparse. Communicate primarily through **context pointers**: to the spec file, the tickets file, a ticket's number, and previous commits. Don't duplicate information already available via pointers.

## What the prompt gives you

Your prompt names, on fixed lines, everything this skill refers to:

- `Spec:` the approved spec, a markdown file. It is the governing contract.
- `Tickets:` the approved ticket set, a markdown file with each ticket's number, criteria and blockers, and its pointers: the files and test files the planner read for it. Pass them to the implementer as the place to start.
- `Ticket count:` how many tickets there are.
- `Run branch:` the branch checked out in your working directory.
- `Base commit:` the commit the run branch started from.
- `Check:` one line per check command, in order.
- `Fix:` one line per fix command, such as `pnpm format`, when the project names any.

After those lines the prompt lists the pinned tickets, one `T<N>: <title>` line each.

On a repair attempt the prompt also has a `Repair attempt: <n> of <limit>` line, followed by each check that did not pass in ZeNorm's own check pass: its output tail in a nonce-delimited block, and the path to its whole output. Step 1 says what to do with it.

The absolute path of `skills/code-review/SKILL.md`, for the review in step 6, is not on those lines: the appended system prompt names it.

`<runDir>` below is the run folder, the parent of your working directory. Every file you or a subagent create lives under it.

## Rules for you and every subagent

Pass these rules to every subagent you start; tool restrictions apply to subagents as they apply to you.

- Change files with the Edit and Write tools, never with shell redirection, `tee` or heredocs.
- Run one simple command per Bash call: no `&&`, `;`, `|`, redirection or subshells. Only simple commands are permitted; a compound one is denied.
- Only the orchestrator changes directory, with `cd <path>` as its own Bash call. Your `cd` persists between Bash calls; a subagent's does not, so every Bash call a subagent makes runs in the run worktree. Subagents never `cd`. Never use `git -C`. The orchestrator `cd`s back to the run worktree before starting any subagent and before anything else that is not the commit of a ticket.
- Implementer subagents of steps 3 and 5 use no Bash at all: only Read, Glob, Grep, Edit and Write, with absolute paths inside their ticket worktree `<runDir>/tickets/t<N>` (a relative path resolves against the run worktree, not the ticket worktree).
- Never push. Never touch the project's own folder or its base branch. Work only under `<runDir>`.
- Run only the check commands the prompt lists, exactly as listed, and only in the run worktree.
- Run only the fix commands the prompt lists on `Fix:` lines, as listed, optionally followed by extra arguments such as a file path; no other command is permitted. The orchestrator may run them in the run worktree, and in a ticket's worktree before `git add` in step 4. The implementer subagents fixing work in the run worktree (the resume fix of step 1, the repair step, and the check and review fixes of steps 4.6, 7 and 8) may run them there. Implementer subagents of steps 3 and 5 run none: they keep their rule of no Bash at all.
- Commit with plain `git add` and `git commit`; the environment already carries the run's git identity.

## Steps

1. Read the spec and tickets files. Read enough to understand the task graph and its first frontier. When the prompt has a `Merged:` line, this run resumes an earlier one: the run branch already holds those tickets, merged. Count them as done, implement and merge only the rest, and when none remain go straight to step 6. When the prompt also has a `Previous run:` line, the run it resumes ended without passing: once every ticket is merged and before step 6, have one implementer subagent fix what it left (its failure, the output of its failed checks, its blocking findings) in the run worktree as in step 7, so the closing review covers the fix. When the prompt has a `Repair attempt:` line, every ticket is already merged: implement and merge none, and do the repair step below before step 6.

   **Repair step.** ZeNorm ran the listed checks on the run branch after the previous session ended, and the checks the prompt lists after `Repair attempt:` did not pass. Have one implementer subagent fix those failures in the run worktree on the run branch, as in step 7: give it each failing check's output tail and the path to its whole output, which it reads for every failure the tail does not show. It never `cd`s, fixes only what makes those checks fail, and commits with `git add` and `git commit`: the attempt must add a commit, or ZeNorm ends the run. Then run every listed check, in order, in the run worktree; if one still fails, have the implementer fix it, commit, and run the checks again. Then go on to step 6, so the closing review covers the fix.

2. (optional) Use an **exploration subagent** to conduct any exploration the tickets need: relevant files in the run worktree. It reads with Read, Glob and Grep and saves its markdown notes under `<runDir>/notes/` with Write, outside the run worktree, so every later subagent can read them and the run worktree stays clean. This lets implementer subagents focus on implementation rather than exploration.

3. For each ticket `N` on the frontier, from the run worktree:
   1. Create its implementer worktree with `git worktree add <runDir>/tickets/t<N> -b <run branch>-t<N> <run branch>`. The ticket is implemented in `<runDir>/tickets/t<N>` on branch `<run branch>-t<N>`.
   2. Start an **implementer subagent** in the background with the description `T<N>: <title>`, the ticket's id and title exactly as the prompt lists them: ZeNorm ties the subagent's work to the ticket by that description. Every other subagent you start (exploration, review, the fixing implementers of steps 7 and 8) gets a description that names no ticket id.
   3. Tell it its ticket number, the spec and tickets paths, its worktree path, the rules above and how to write its report. It implements only its ticket, with the tools and paths the rules allow, reports the files it changed, and stops. It runs no check and makes no commit.
   4. Its report becomes the ticket's summary in ZeNorm, so it names files by their path relative to its worktree and says what it changed and why; it does not say which rules it followed or that it ran no checks.

4. Once an implementer subagent completes, commit and merge its work yourself, one ticket at a time, so merges never race on the run branch. Each command is its own Bash call:
   1. `cd <runDir>/tickets/t<N>`, then `git status` to see what changed.
   2. When the prompt has `Fix:` lines, run each listed fix command there, as its own Bash call, then `git status` again.
   3. `git add <paths>` (or `git add .`), then `git commit -m "T<N>: <title>"`.
   4. `cd` to the run worktree again before anything else.
   5. `git merge --no-ff <run branch>-t<N>`, exactly this form: ZeNorm records the ticket as merged from it. If it conflicts, resolve each conflict with Edit, then `git add` the resolved files and `git commit`.
   6. When the checks are cheap, run them now in the run worktree. If one fails, have an implementer subagent fix the cause in the run worktree as in step 8.

   The run worktree is clean after each merge.

5. If this changes the **frontier** of available tickets, create their worktrees from the updated run branch (in the run worktree) and start more implementer subagents at once, as in step 3.

6. Once every ticket is merged, start one **review subagent** that reviews `<base commit>..HEAD` in the run worktree by following the Code Review skill at the absolute path the appended system prompt gives, on both axes (Standards and Spec), with the spec and tickets files as the governing contract. Its Bash runs in the run worktree and it never `cd`s. It reports findings and changes nothing.

7. If the review reports blocking findings, fix them all in a single **implementer subagent** working in the run worktree on the run branch (nothing else runs by then). It never `cd`s, addresses only the blocking findings and commits with `git add` and `git commit`.

8. Run every listed check, in order, in the run worktree. If one fails, have one implementer subagent fix the cause in the run worktree as in step 7, commit, and run the checks again.

9. End in the run worktree with all work committed on the run branch and `git status --porcelain` printing nothing. Leave the implementer worktrees and branches as they are: when the run ends, ZeNorm removes the run worktree and every implementer worktree and deletes every `<run branch>-t<N>` branch itself, and keeps the run branch.

## Provenance

Adapted on October 7, 2026 from [`skills/engineering/implement-spec/SKILL.md`](https://github.com/mattpocock/skills/blob/c612defa9e5cf9372262d0279eb124993ba77b71/skills/engineering/implement-spec/SKILL.md) in mattpocock/skills, per the slice 4 delivery spec D1 and ledger row L79. Kept: the task graph, the frontier, context pointers, background implementer subagents, the closing code review with one fixing implementer. Changed: the spec and tickets are files named in the prompt; ZeNorm creates the run branch and worktree, so the branch, pull request and "mark ready" steps are gone; implementer worktrees live under the run folder on suffixed branches; the session runs the checks and ends clean; one simple command per Bash call.

Amended:

- October 7, 2026, L91: a subagent's `cd` does not persist between its Bash calls, so implementer subagents use no Bash and the orchestrator commits and merges each ticket itself; there are no merger subagents.
- October 9, 2026, slice 8 delivery spec D4 and L184: each implementer subagent's description is `T<N>: <title>` and each merge is `git merge --no-ff <run branch>-t<N>`, so ZeNorm can follow per-ticket progress; ZeNorm removes the run's worktrees when the run ends and keeps the run branch, reversing the earlier "worktrees are kept" note (supersedes L81/L86).
- October 9, 2026, L197: an implementer's report names files relative to its worktree and says what it changed and why, because it becomes the ticket's summary.
- October 10, 2026: each ticket in the tickets file lists its pointers, the files and test files the planner read for it.
- October 12, 2026: a resumed run's `Merged:` tickets count as done, and what the run it resumes left to fix (its `Previous run:` failure, failed checks and blocking findings) is fixed before the closing review.
- October 14, 2026: a repair attempt's prompt (`Repair attempt:`, after ZeNorm's own checks failed) has one implementer fix the failing checks in the run worktree, commit, and run the listed checks again, before the closing review; it merges no ticket.
- October 14, 2026, delivery repair spec C4: the prompt's `Fix:` lines name the project's fix commands, which the orchestrator may run in the run worktree and in a ticket's worktree before committing it (step 4.2), and the implementers fixing work in the run worktree (resume, repair, check and review fixes) may run there; implementers of a single ticket keep no Bash.
