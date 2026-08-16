---
name: install-anti-slop
description: Install and configure the anti-slop Oxlint plugin in a local TypeScript or JavaScript repository for Antigravity 2.0. Use whenever a user asks to add anti-slop lint rules, copy the anti-slop plugin, configure opinionated Oxlint rules, or migrate an existing local anti-slop setup.
---

# Install anti-slop for Antigravity 2.0

Install the bundled Oxlint plugin into the current repository and integrate it with the repository's existing lint setup. Preserve unrelated work and adapt to the project's package manager and configuration style.

## Procedure

1. Inspect the repository before changing it:
   - Read its agent instructions.
   - Check `git status` and preserve unrelated changes.
   - Identify the package manager from `packageManager` and lockfiles.
   - Find Oxlint configuration (`oxlint.config.*`, `.oxlintrc*`, or a Vite+ config).
   - Check whether anti-slop files or rules already exist. Do not overwrite them without reviewing the diff.

2. Copy the bundled plugin from this skill. Run from the target repository:

   ```bash
   node <skill-directory>/scripts/install.mjs
   ```

   This creates `tools/oxlint/anti-slop/`. Pass another relative destination as the first argument when the repository has an established tooling layout. The script refuses to replace an existing destination; only use `--force` after backing up and reviewing existing files.

3. Install current compatible dependencies rather than trusting versions remembered by the agent:
   - Query `npm view oxlint version` and `npm view @oxlint/plugins version`.
   - Install the same current version of both packages with the repository's package manager.
   - `oxlint` is a development dependency. The copied source imports `@oxlint/plugins`, so install it as a development dependency for a local-only plugin.
   - Do not replace the package manager or rewrite unrelated dependency ranges.

4. Register the plugin, configure ignores, and enable all rules. For `oxlint.config.ts` or `.oxlintrc.json`, merge these fields with the existing configuration:

   ```ts
   ignorePatterns: [
     ".agent/**",
     ".agents/**",
     ".claude/**",
     ".codex/**",
     ".continue/**",
     ".cursor/**",
     ".gemini/**",
     ".opencode/**",
     ".pi/**",
     ".roo/**",
     ".windsurf/**",
     "tools/oxlint/anti-slop/**",
   ],
   jsPlugins: [
     { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
   ],
   ```

   Enable these rules at `"error"`:

   ```json
   {
     "anti-slop/no-chained-type-assertions": "error",
     "anti-slop/no-conditional-empty-object-spread": "error",
     "anti-slop/no-known-value-widening": "error",
     "anti-slop/no-module-mocking": "error",
     "anti-slop/no-object-parameters": "error",
     "anti-slop/no-reflect-apply": "error",
     "anti-slop/no-reflect-get": "error",
     "anti-slop/no-runtime-typeof": "error",
     "anti-slop/no-shape-in-symbol-names": "error",
     "anti-slop/no-unknown-parameters": "error",
     "anti-slop/no-unknown-returns": "error",
     "anti-slop/no-unknown-type-aliases": "error",
     "anti-slop/no-unsafe-dictionary-type": "error",
     "anti-slop/no-widen-then-assert": "error",
     "anti-slop/require-safety-comment-for-type-assertion": "error"
   }
   ```

5. Run the repository's lint command and typecheck. If findings appear in owned project source, remediate them using high-evidence patterns (inference, `satisfies`, named owner contracts, boundary parsing, and `// SAFETY:` comments).
