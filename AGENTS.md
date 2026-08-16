# Alpha Premier Attendance — Agent Instructions

## Mandatory Skills

Every coding task in this repository MUST use the following two skills together, in this order:

1. **Ponytail** — read and follow `.agents/skills/ponytail/SKILL.md` before planning or editing.
   Apply Ponytail in `full` mode by default: question whether work is needed, reuse existing
   code, prefer standard-library and native solutions, and make the smallest correct change.
   Keep validation, error handling, security, accessibility, and explicitly requested behavior
   intact. Do not disable Ponytail unless the user explicitly says `stop ponytail` or `normal mode`.

2. **Unlazy** — read and follow `.agents/skills/unlazy/SKILL.md` before starting real work.
   Apply anti-laziness discipline: write acceptance gates to `GATES.md` *before* implementing,
   one checkbox per outcome, with `CHECK:`/`EXPECT:` lines wherever an outcome can be run as a
   command. Done means every gate is checked **with recorded evidence** (run
   `node <skill-dir>/scripts/gate-check.mjs GATES.md`), not a promise of completion. Pick solo
   mode for tasks under ~30 minutes, orchestrated mode (`PLAN.md` + `gates/` per leaf) for builds.
   Re-measure every number in the final report at report time; paste the ledger, N of N checked.

Ponytail governs *what* you build (the simplest correct thing); Unlazy governs *whether it is
actually done* (gates + evidence, no 80% reports). Both apply to every coding task, including
reviewing and refactoring. Substantial multi-file work also follows `.agent/rules/anti-slop.md`
type-safety rules and `.agents/rules/anti-slop.md`.
