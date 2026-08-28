# Acceptance Gates — FIX_BUGS.md

- [x] All 18 documented bugs are implemented, with no placeholders or TODOs.
  EVIDENCE: Implemented across client/src/{App.tsx,api.ts,bathroom-key-log.tsx,bathroom-kiosk-view.tsx,speech.ts,update-banner.tsx,voice-settings-panel.tsx,file-actions.tsx,styles.css}, shared/src/api-contracts.ts, and src-tauri/src/services plus lib.rs; focused tests added/updated.
- [x] TypeScript validation passes.
  CHECK: npm run typecheck
  EXPECT: exit code 0
  EVIDENCE: exit code 0 in final combined validation.
- [x] Oxlint validation passes.
  CHECK: npm run lint:oxlint
  EXPECT: exit code 0
  EVIDENCE: exit code 0 in final combined validation.
- [x] Unit & component tests pass.
  CHECK: npm test
  EXPECT: exit code 0
  EVIDENCE: exit code 0; final run completed shared/client/server test suites.
- [x] Rust compilation and tests pass.
  CHECK: cargo check --manifest-path src-tauri/Cargo.toml && cargo test --manifest-path src-tauri/Cargo.toml
  EXPECT: exit code 0
  EVIDENCE: cargo check passed; cargo test reported 147 passed, 0 failed.
- [x] Tauri MCP doctor passes.
  CHECK: npm run doctor:mcp
  EXPECT: exit code 0
  EVIDENCE: bridge healthy on port 9223; all doctor checks passed.
- [x] Final diff is reviewed for scope, type-safety, and regressions.
  EVIDENCE: git diff --check passed; anti-slop unsafe cast issue in offline queue was replaced with a typed OfflineScanResponse; no new dependencies added.
