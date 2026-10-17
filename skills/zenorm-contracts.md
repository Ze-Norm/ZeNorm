# ZeNorm contracts and delivery

Read during specification, ticket synthesis, reconciliation, implementation, review or handoff.

## Revisions and reconciliation

Keep discovery drafts, candidate specification revisions, and approved build-ready revisions distinguishable using the supplied record states. Publish substantive prose with identifiable clauses, criteria, rationale, and scoped references. Preserve existing element identities where their meaning continues; use returned identities for new elements.

After a specification edit, reconcile affected work against previous intent, revised intent, actual code, and completed/in-progress evidence. Retain coverage/disposition findings with their governing revision and criterion references. Unchanged work may retain its applicable agreement and be cleared with evidence under the existing rules; changed requirements use the applicable human review. Respect the returned locks and holds. A saved edit does not inherit blanket approval.

Completed tasks and results remain attached to their original contracts. Later changes use linked follow-ups. Distinguish evidence already satisfying a commitment from a plan to verify it. Inspect named effort and ticket branches when the current checkout lacks implementation.

## Bounded work and continuation

The workspace conversation persists across bounded assignments. The application selects eligible work from saved blockers, claims, human waits and contract revisions. Each decision ticket, Research child, Prototype preparation/demo, To Spec assignment and To Tickets assignment starts with a fresh agent context. Grilling rounds may resume the same ticket and claim; a new assignment reconstructs its inputs from authoritative records. An assignment receives its relevant skills and tools, retains its context manifest, and ends when it submits a result or requests human input. The application dispatches the next eligible assignment.

ZeNorm automatically starts eligible Research and Prototype preparation when tickets are created or unblocked. Use the supplied claim/dispatch context; do not duplicate an already running assignment. Independent discovery work may run concurrently. Research findings can complete an investigation; Prototype preparation pauses for actual human answers and the separate final verdict. Scheduling and progress presentation belong to the runtime and app.

MVP implementation tickets must be verifiable by agents in a concrete available environment. Human planning, feedback and merge control remain; human ticket acceptance is not a runtime stage. Synthesis audits executability and reconciles incompatible requirements before dispatch.

Implementation is one delivery run per project at a time, through the executor chosen by `delivery.executor` (local or a plugin's); within a run, implementer subagents build each ticket frontier in parallel, under the supplied task contract. Skills consume the assigned work and return evidence through the execution interface; the application owns dispatch, continuation, and eligibility. Keep checks, separate Standards and Spec reviews, and a verified commit. Human merge control remains. No messages reach a running delivery run in the initial release; inspection and retained results support visibility.

A handoff carries authoritative references, exact revisions, claims, pending questions, settled scope, and the next bounded action. Fresh agents recover full sources through those references and supplied tools. Conversation summaries preserve orientation without replacing the records that authorize the next action.
