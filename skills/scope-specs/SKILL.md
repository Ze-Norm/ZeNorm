---
name: scope-specs
description: Choose and preserve specification boundaries for a cleared Wayfinder map before synthesis. Use when handing off a cleared map, deciding whether it needs one or several specs, or revising its specification scopes. Compose with to-spec when synthesis is requested.
---

Read [ZeNorm integration](../zenorm-integration.md) for authoritative records, human input, revisions, and runtime responsibilities.

# Scope Specs

Own the coordination step between a cleared map and specification synthesis. Treat this as an extension around Matt Pocock's workflow; the repository-owned handoff skills retain their own procedures and canonical terminology. Agile parallels do not rename a map or introduce an Epic artifact.

## Recover the handoff context

Read the supplied map, linked resolution bodies and corrections, current direction, and relevant source documents and prototype approval records. Distinguish settled requirements from illustrative material and unanswered questions. Keep unresolved scope provisional while progressing independent work.

Read the project's tracker conventions and existing scope records and specifications. Recover prior human agreements and published artifact references before proposing changes or choosing output locations. Determine whether the request covers scoping alone, specification synthesis, or also ticket creation.

## Propose bounded contracts

Reuse boundaries already agreed with the user. Propose new or changed scopes around coherent user outcomes and contracts that can be reviewed and changed independently. A map may feed one or several specs; existing specs may absorb a bounded revision. Let the requested destination determine the work, rather than a fixed spec count, implementation layers, or the entire product's possible future scope.

For each scope, state:

- The user outcome and included and excluded behavior.
- The target new or existing spec and its intended output location or tracker destination.
- Governing decision links, relevant prototype approvals, and current shared constraints.
- Dependencies on other scopes or existing specs, and which spec governs each shared rule.

Check that proposed and retained specs collectively cover every agreed obligation of the requested destination, including its adoption evidence, while preserving exclusions. Show where each obligation belongs. Resolve conflicting ownership of shared rules and identify obligations that consuming specs must carry. Dependencies describe actual constraints; scope boundaries need not become sequential implementation phases.

## Establish and preserve the boundaries

Present the outline and coverage check. Ask only about new, changed, or unresolved boundaries; reuse actual prior human agreement. Keep recommendations marked as proposed until answered, and record agreement from the user's answer rather than inferring it from silence.

Retrieve and persist the outline through the supplied tools in the existing planning or decision record, using its record types and statuses, and link it from the map. Retain stable specification identities and the exact source revision and human-response references for each agreed boundary. Retain its status, supporting human answer, source references, scope targets, and output locations so another session can resume. Reuse and revise the existing handoff record according to tracker conventions; preserve earlier agreement and artifact references when scopes change. For local files, choose paths that keep delivery artifacts distinct from existing discovery tickets. Keep the map as an index and the glossary as vocabulary.

A scope-only request ends with the agreed, recoverable handoff. If an answer is pending, report the unresolved boundary and the saved proposal.

## Compose with the requested handoff

When synthesis is requested and the boundaries are agreed, read the repository's [to-spec](../to-spec/SKILL.md). Follow it separately for each scope, supplying its recorded outline, full governing decisions/research, prototype verdict scope, existing specifications and work evidence, applicable testing agreements, and target artifact. Let it perform its testing-seam check and synthesis; respect existing artifact identity and the project's revision conventions.

When ticket creation or reconciliation is also requested, read the repository's [to-tickets](../to-tickets/SKILL.md). Supply each resulting spec, related contracts, actual code, and completed/in-progress work; follow its coverage audit, sizing, dependency, review, and publication workflow. Scope agreement does not replace either skill's later checks. Preserve unchanged commitments and completed work; create tasks only for necessary changes.

Update the handoff record with published spec and ticket references as those steps finish. On resumption, continue from those references instead of creating duplicate artifacts. If a required skill or tracker destination is unavailable, finish the independent scoping work and report the missing handoff input; preserve the proposal rather than inventing a substitute workflow or publication target.
