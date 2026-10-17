---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up.
---

Read [ZeNorm integration](../zenorm-integration.md) for authoritative records, human input, revisions, and runtime responsibilities.

Write a handoff summary so a fresh agent can continue the work. In ZeNorm, publish it through the supplied handoff/discussion destination and return its reference. For a portable file in a direct repository session, save it to the OS temporary directory.

Include suggested skills with the repository paths or packaged resource references the next agent can actually read. Carry the assigned work, exact artifact revisions, claim, pending input requests, actual human-response/verdict references, completed evidence, and next bounded action. State which full records the next agent must retrieve through the supplied tools before continuing.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.
