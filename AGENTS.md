# Multi-Agent Working Agreement

These instructions apply to every human or AI agent working in this repository,
including ChatGPT Work/Codex and Cursor. The repository, its canonical docs, and
`docs/AGENT_COORDINATION.md` are the shared source of truth; chat history is not.

## Before implementation

1. Inspect `git status --short --branch`, the current branch, recent commits,
   and relevant diffs. Preserve changes you do not own.
2. Read `docs/AGENT_COORDINATION.md`, `docs/README.md`,
   `docs/architecture-decisions.md`, and the affected scope, HLD, LLD, UX,
   security, diagrams, and roadmap sections.
3. Inspect the Hybrid AI SDK public package and its documentation at
   `/home/igdclt0603/Desktop/Ash/hybridAi`. Never copy its private source or
   depend on private headers or internal implementation details.
4. Before meaningful edits, record the agent, branch, task, and claimed files
   in `docs/AGENT_COORDINATION.md`. If another active claim overlaps, stop and
   coordinate rather than editing the same area concurrently.

## Working rules

- The original audio or written entry is the source of truth. AI-derived
  content is optional, replaceable, and traceable to source ranges.
- The journal remains useful offline and without a Private AI Node. AI failure
  must never lose or corrupt a recording or source entry.
- No account, sign-up, sign-in, public cloud, or telemetry containing journal
  content may be introduced without an explicit accepted ADR.
- Biometrics are only a convenience unlock. PIN/passcode fallback is mandatory,
  and raw biometric data must never enter application storage or logs.
- Use Hybrid AI only through packaged/public APIs and versioned capability
  contracts. Journal-specific behavior stays in this repository or the paired
  Private AI Node, not in SDK core.
- Do not silently resolve an item marked Open in the architecture docs. Record
  alternatives and obtain a decision before implementation depends on it.
- Keep requirements, ADRs, HLD, LLD, UX, security, diagrams, roadmap, tests,
  and implementation synchronized. Never claim untested behavior is working.
- Do not commit, push, switch branches, rewrite history, discard changes, or
  run destructive Git commands unless the user explicitly requests it.

## Handoff

At the end of meaningful work, update `docs/AGENT_COORDINATION.md` with the
completed and remaining work, touched files, permanent-doc links, validation
commands/results, known failures, and next recommended task. Keep durable
decisions in canonical documents, not in the coordination file.
