---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
---

Implement the assigned contract in the supplied checkout and branch. Before editing, recover the full ticket and exact governing specification revision(s), clause/criterion references, scoped source decisions and prototype/demo verdicts, testing agreement, exclusions, dependencies, and retained work evidence. Use the execution interface's assignment and review base. If a governing input or authority is missing, return the gap without substituting a newer contract.

MVP ticket completion is agent-verifiable. Exercise the required user behavior with the supplied tools, including real browser input for browser journeys; a loading smoke test alone does not prove interaction. Record the actual environment and limits of performance evidence. Do not introduce human play/signoff as a completion gate. If the assigned approved contract still requires human acceptance or unavailable hardware, return a held result naming that criterion and the required planning correction; never silently weaken the contract.

Keep all work, including experiments and throwaway files, inside the assigned checkout. Do not write to `/tmp`, `$TMPDIR`, the home directory or any other location outside it, and do not move `node_modules` or other project directories out of it. Leave the caches a toolchain maintains for itself (`~/.npm`, the pnpm store, pip, cargo, Go) to that toolchain. Remove every scratch file and directory you created before the final commit; the checkout must be clean afterwards. The host records writes outside the checkout and those caches with the run's evidence.

Use `/tdd` where supplied and appropriate, at the agreed seams; otherwise follow the contract's testing expectations directly. Run typechecking and focused checks while implementing, and the full required suite once at the end. Verify every acceptance criterion or record the specific unmet obligation.

When the execution assignment says ZeNorm owns completion, stop after implementing, running affected focused checks, and committing the proposed result. Return the supplied proposal schema. The host launches both review axes, returns blocking findings for at most one repair round, executes final required checks, and constructs retained check evidence. Do not start another reviewer workflow, reconstruct command history, or repeat full verification yourself. A completed code proposal is not a verified ticket. On the repair round, address only supplied blocking findings; defer optional improvements.

For direct sessions without host-owned completion, use the repository [Code Review](../code-review/SKILL.md) before committing, supplying the fixed review base, the actual worktree diff, and exact governing inputs. Keep Standards and Spec results separate. Address findings that prevent satisfying the contract and rerun affected checks/reviews when the change warrants it.

Commit the verified work to the assigned branch. Return inspectable evidence through the supplied execution interface: task and governing revision/criterion references, checkout/branch, base and resulting commit, changed files, check commands and outcomes with logs/artifact references, both review reports, and remaining failures or limitations. A skipped required review or failed required check leaves the task incomplete even if a process exits successfully or a commit exists.

The runtime owns continuation to the next sequential task. A changed requirement encountered during execution is reported against the assigned contract for reconciliation; completed results stay attached to that contract and later changes use linked follow-ups.
