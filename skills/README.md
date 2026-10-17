# Skills

ZeNorm's agents follow these skills. Product runs read them at run time, by absolute path in an appended system-prompt file; they are never discovered from a developer's home directory or linked into a run worktree.

| Used by                                        | Skill                                                                                                                                                                       |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Planning runs                                  | [Product To Spec](product-to-spec/SKILL.md), [Product Planning Review](product-planning-review/SKILL.md), [Product To Tickets](product-to-tickets/SKILL.md)                  |
| Delivery runs                                  | [Implement Spec](implement-spec/SKILL.md) (the orchestrator session), [Code Review](code-review/SKILL.md) (the separate read-only reviewer session), [PR](pr/SKILL.md) (the read-only session that writes a passed run's pull request body on a GitHub project) |
| Developing ZeNorm itself: discovery            | [Wayfinder](wayfinder/SKILL.md), [Grilling](grilling/SKILL.md), [Research](research/SKILL.md), [Prototype](prototype/SKILL.md), [Domain Modeling](domain-modeling/SKILL.md) |
| Developing ZeNorm itself: demo and handoff     | [High-fidelity demo](high-fidelity-demo/SKILL.md), [Scope Specs](scope-specs/SKILL.md), [To Spec](to-spec/SKILL.md), [Planning Review](planning-review/SKILL.md), [To Tickets](to-tickets/SKILL.md) |
| Developing ZeNorm itself: execution            | [Implement](implement/SKILL.md)                                                                                                                                             |
| Developing ZeNorm itself: continuation         | [Handoff](handoff/SKILL.md), [Grill Me](grill-me/SKILL.md), [Grill with Docs](grill-with-docs/SKILL.md)                                                                     |

[ZeNorm integration](zenorm-integration.md) is the shared reference every skill points to: authoritative context, tool-backed records and human input, revision rules and runtime responsibilities. [ZeNorm contracts](zenorm-contracts.md) describes the records the product skills write.

The development skills use local planning records under `.scratch/` as their tracker. That directory is private and gitignored; product runs use ZeNorm's own records instead.

## Attribution

Many of these skills are adapted from Matt Pocock's [skills](https://github.com/mattpocock/skills), and ZeNorm uses the vocabulary of their workflow: Wayfinder, maps, Grilling, Research, Prototype, specifications and tickets. They are used under the MIT License; the notice is in [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md#mattpocockskills), alongside the shadcn/ui notice for the [demo template](high-fidelity-demo/template)'s components. The vendored [PR](pr/SKILL.md) skill also carries the notice in its own file, since delivery sessions read it on its own.
