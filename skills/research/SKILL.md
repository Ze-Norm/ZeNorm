---
name: research
description: Investigate a question against high-trust primary sources and publish a linked report with cited findings and limitations. Use when the user wants a topic researched, docs or API facts gathered, or reading legwork delegated to a background agent.
---

Read [ZeNorm integration](../zenorm-integration.md) for authoritative records, human input, revisions, and runtime responsibilities.

Use a **background investigator** so independent work can continue. If this run is already the assigned investigator, do the research here. In ZeNorm, use the supplied assignment; in a direct repository session, delegate the bounded question with its sources and report destination.

Before any external research, take the code that depends on what the change replaces or extends from the code facts you were given (in ZeNorm, the map's code survey), opening the checked-out repository only for what they do not cover, and for each such dependency state as a finding whether the new option supports it as the code uses it today, citing the file path; record one you cannot verify as an assumption. Then identify the decision this fact changes and the smallest primary evidence that can settle it. Stop once that question is answered with its material limitations. Broaden to implementation sources only when primary documentation leaves a decision-changing contradiction or gap. If the question rests on an unconfirmed scope assumption, report that gap instead of exploring every possible implementation.

Its job:

1. For a command-line tool or service, check its own reference (documented `--help` text, command and flag reference, configuration and event or output schema docs, source where published) for each specific capability the decision needs before concluding it is absent; state an absence only with the source checked.
2. Investigate the question against **primary sources** (official docs, source code, specs, first-party APIs), not a secondary write-up of them. Follow every claim back to the source that owns it.
3. Write a report with the question, concise summary, findings cited to their primary sources, limitations, and remaining uncertainties. Include source versions/dates where they affect the answer. Distinguish established facts, inference, and recommendations.
4. Publish the report through the supplied tools and link it to its decision ticket. In the local tracker, save a Markdown report at the supplied research destination and link it from the ticket.
5. Return the report reference and whether the bounded investigation is answered. Leave it unanswered only for a gap the human can close (a preference, scope, access, a fact about their environment or data), and state that gap; a recommendation cannot answer a human preference. When what remains can only be settled by running something (a live experiment or spike), not by documentation or source, answer with what primary sources establish and record each unverified part as an assumption that names its risk and how delivery verifies it (an opt-in live test, an early spike ticket); never leave it as a gap for the human. Leave progress presentation to the runtime and app.
