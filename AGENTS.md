# Alpha Premier Attendance — Agent Instructions

## Mandatory Engineering Quartet: Ponytail + Unlazy + Anti-Slop + Grill-Me (Active Every Prompt)

On every user prompt and for every task, all four skills and disciplines are automatically active simultaneously without exception:

### 1. Grill-Me (Relentless Design-Tree Interview & Plan Sharpening)
Before executing ambiguous or non-trivial design/planning decisions:
1. **Map the Design Tree**: Treat every requirement and decision as a tree of dependent choices.
2. **Work the Frontier in Rounds**: Identify unsettled prerequisites and ask structured frontier questions with numbered choices and recommended answers (`❓ **Q1**`, `➡️ Recommended`).
3. **Fact-Finding Is Agent's Job**: Check code and facts autonomously via tools/sub-agents before asking the user; only ask the user for genuine design decisions and requirements.
4. **Reach Shared Understanding**: Clarify implicit assumptions and confirm the plan before executing irreversible or wide-reaching changes.

### 2. Ponytail (Minimal Viable Solution Architecture)
Before writing any code, stop at the first rung that holds:
1. **YAGNI**: Does this need to exist at all? Skip speculative needs.
2. **Reuse**: Does it already exist in this codebase? Reuse existing helpers, types, and patterns.
3. **Stdlib**: Does the standard library do it? Use standard library.
4. **Native**: Does a platform-native feature cover it? Use native HTML/CSS/DB constraints over libraries.
5. **Installed Deps**: Does an already-installed dependency solve it? Use it; do not add new packages.
6. **One-Liner**: Can it be one line? Keep it to one line.
7. **Minimum Code**: Write only the smallest diff that works once root cause and data flow are understood.

No unrequested abstractions, no speculative boilerplate, deletion over addition. Active in `full` mode by default.

### 3. Unlazy (Exhaustive Execution & Verifiable Evidence)
Every task is executed under anti-laziness discipline to ensure completion with verified evidence rather than assumptions or premature status reports:
1. **Root-Cause Understanding**: Trace relevant call paths, state, and boundaries end-to-end before touching code.
2. **Gates Before Work**: For non-trivial tasks, record acceptance gates in `GATES.md` before implementation with runnable `CHECK:` / `EXPECT:` commands or concrete `EVIDENCE:` requirements.
3. **Never Stop at 80%**: Implement completely (no placeholders, no TODOs, no simulated work).
4. **Adversarial Verification**: When feeling done, run checks and actively attempt to refute the result.
5. **Measured Claims**: Every number, count, and result in final reports must be measured directly from commands, not stated from memory.

### 4. Anti-Slop (Strict Type & Contract Evidence)
Enforce rigorous compiler-backed TypeScript/JavaScript safety across the entire repository:
1. **Explicit Safety Comments**: Every non-const type assertion (`as T`) MUST be immediately preceded by `// SAFETY: <explanation>`.
2. **No Double Casting**: Never use chained assertions (`as unknown as T` or `as any as T`).
3. **No Conditional Empty Object Spread**: Avoid `...(cond ? { k: v } : {})`.
4. **No Broad Dictionary Widening**: No open `Record<string, unknown>`. Use schema validation, inference, `satisfies`, or domain interfaces.
5. **No Low-Evidence Runtime `typeof`**: Validate at I/O boundaries and branch on typed domain models.
6. **No `unknown` / `any` Parameters or Return Types**: Strict domain contracts on internal functions.
7. **Verification**: Run `npm run lint:oxlint`, `npm run typecheck`, and `npm test` before declaring done.

Follow the rules in `.agent/rules/` and `.agents/rules/` (`ponytail.md`, `unlazy.md`, `anti-slop.md`, and `grill-me.md`).

---

### Local Release Policy (Never CI/CD Releases)
- **Do not use GitHub Actions for releases**: Building Windows Tauri desktop release bundles in CI/CD takes too long.
- **Generate on Local PC**: All production release installers/bundles must be generated locally on the developer PC via `npm run tauri:build`.
- **Upload Manually to GitHub**: Upload the generated MSI/EXE bundles directly to GitHub Releases.

---

### Verification Workflow
Run the narrowest relevant checks first, followed by required repository gates. Review the diff for dead code, unrequested complexity, type assertions without safety comments, and unnecessary dependencies.

### Agent Response Format
Keep responses concise unless detail is requested:

### Changed
- What behavior changed and where.

### Verified
- Commands, tests, or checks run and the result.

### Notes
- Only concrete risks, limitations, or relevant follow-ups.

Do not provide long plans, chain-of-thought-style reasoning, exhaustive investigation logs, or optional suggestions unless requested.
