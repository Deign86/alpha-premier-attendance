# Alpha Premier Attendance — Agent Instructions

## Engineering Mode: Ponytail Default, Unlazy Escalation

### Default: Ponytail

For every task, inspect the relevant code, tests, types, configuration, and repository patterns before editing. Reuse existing code, utilities, dependencies, and conventions. Prefer, in order:

1. No change when the behavior already exists.
2. Deletion or simplification.
3. Existing repository code.
4. Standard-library or native framework/platform features.
5. Already-installed dependencies.
6. Minimal custom code only when necessary.

Do not add packages, abstractions, wrappers, services, configuration, files, feature flags, or broad refactors unless clearly required. Modify only necessary files; preserve correctness, security, validation, error handling, type safety, accessibility, and local conventions. Do not add speculative features or future-proofing. Use the global Pi **Ponytail** skill in `full` mode by default; it may be disabled only for the current interaction by `stop ponytail` or `normal mode`.

### Escalate: Unlazy

Use the global Pi **Unlazy** skill for multi-file, cross-system, ambiguous, hard-to-reproduce, security-sensitive, performance-sensitive, side-effectful, concurrency-heavy, or root-cause-unverified work, and after a failed or assumption-based fix. In Unlazy mode, identify the expected behavior and verified cause, trace relevant call paths and state/data/type boundaries, distinguish evidence from assumptions, check edge and failure paths, address the verified cause with the smallest solution, and verify beyond the first plausible fix. For substantial work, write acceptance gates to `GATES.md` before implementation and finish with recorded evidence; use the skill's solo or orchestrated mode as appropriate.

### Verification

Run the narrowest relevant tests, type checks, lint, build, or reproduction first, then broader checks only when justified. Review the final diff for unrelated changes, dead code, duplicate logic, unused imports, unnecessary dependencies, and unnecessary complexity. State exactly what was not run and why when verification cannot run.

### Agent Response Format

Keep responses concise unless detail is requested:

### Changed
- What behavior changed and where.

### Verified
- Commands, tests, or checks run and the result.

### Notes
- Only concrete risks, limitations, or relevant follow-ups.

Do not provide long plans, chain-of-thought-style reasoning, exhaustive investigation logs, or optional suggestions unless requested. Substantial multi-file work also follows the type-safety rules in `.agent/rules/anti-slop.md` and `.agents/rules/anti-slop.md`.
