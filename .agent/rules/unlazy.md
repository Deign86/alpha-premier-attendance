# Unlazy Execution Discipline

Enforce anti-laziness execution rigor across all tasks to prevent premature completion, 80% stalls, and assumption-based fixes.

## Core Rules

1. **Root Cause Over Symptoms**: Fully trace call paths, state, and type boundaries end-to-end before touching code. Patch the shared root cause once, not just the path named in the ticket.
2. **Gates Before Work**: For non-trivial work, write acceptance gates to `GATES.md` before implementation with runnable `CHECK:` / `EXPECT:` commands or concrete `EVIDENCE:` requirements.
3. **No Premature Reports**: Never report completion while acceptance gates or evidence checks remain unverified.
4. **No Simulation of Work**: If an action is testable or reversible, run the check and observe real output rather than speculating.
5. **Adversarial Verification**: When feeling done, run checks and actively attempt to refute the result.
6. **Strict Measurement**: Re-measure all stated numbers, line counts, and test passes directly from command execution; never state figures from memory or assumptions.
