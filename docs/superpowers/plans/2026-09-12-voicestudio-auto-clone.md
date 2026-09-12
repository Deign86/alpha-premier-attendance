# VoiceStudio Auto-Clone Plan — kiosk pulls name clips over LAN (2026-09-12)

## Goal
New intern/employee registration auto-produces the Ma'am Bea name clip with zero manual
steps, zero GitHub uploads, and zero software installed on the VoiceStudio host PC.

## Locked decisions (from owner Q&A)
1. Async queue after save — registration never blocks; Tier 2 Piper speaks the name meanwhile.
2. Inputtable host address in UI — any LAN PC running VoiceStudio works (`voiceStudioBaseUrl`).
3. Kiosk pulls — kiosk calls the host's built-in HTTP API and saves the mp3 itself.
4. Offline host → queue + Piper fallback — jobs retry with backoff until the host returns.

## Architecture
```
[ Registration save (kiosk) ] ──enqueue──> [ voice_jobs table: PENDING ]
        │                                            │
        ▼ (plays Tier 2 Piper immediately)           ▼ background worker (kiosk only)
[ Kiosk scan playback ]                  POST <host>/v1/audio/speech
                                         { voice: Bea profile, response_format: mp3 }
                                                     │ save bytes
                                                     ▼
                                   voices/bea/names/<personId>.mp3 + manifest patch
```
Host PC runs stock VoiceStudio only. All new code lives on the kiosk/attendance PC.

## Phase 1 — Host address in UI (DONE, verified 2026-09-12)
- `shared/src/api-contracts.ts`: `TtsSettings.voiceStudioBaseUrl?` (optional — zero breakage).
- `client/src/services/ttsService.ts`: default `http://127.0.0.1:3900`,
  `normalizeVoiceStudioBaseUrl`, `checkVoiceStudioConnection` (`GET <host>/profiles`).
- `client/src/voice-settings-panel.tsx`: VoiceStudio Server card + Test Connection.
- EVIDENCE: client tsc clean, 70/70 targeted tests, oxlint clean.
- `shared/src/api-contracts.ts`: `TtsSettings.voiceStudioBaseUrl`.
- `client/src/services/ttsService.ts`: default `http://127.0.0.1:3900`,
  `normalizeVoiceStudioBaseUrl`, `checkVoiceStudioConnection` (`GET <host>/profiles`).
- `client/src/voice-settings-panel.tsx`: VoiceStudio Server card + Test Connection.
- Tests: `ttsService.test.ts` custom-settings object extended; panel test asserts the field.

## Phase 2 — Queue table + enqueue hook (DONE, verified 2026-09-12)
- Migration `0017_voice_jobs.sql`: `voice_jobs` + `app_settings` tables.
- Enqueue in `admin_upsert_user_inner` (`lib.rs`): ACTIVE INTERN/EMPLOYEE (non-assist)
  → PENDING job; renames re-queue via upsert. EVIDENCE: `enqueue_upserts_and_resets_on_rename`.

## Phase 3 — Pull worker, kiosk only (DONE, verified 2026-09-12)
- `services/voice_pull.rs`: profile discovery (`GET /profiles`, name~bea),
  `POST /v1/audio/speech` (`model: tts-1`, mp3), strict mp3 content-type,
  save to `<data_dir>/voices/bea/names/<id>.mp3`, backoff 1m→6h.
  Design note: `/v1/audio/speech` (not `/generate`) so the HOST encodes mp3 —
  the kiosk has no ffmpeg and gains no new dependency.
- Commands `get/set_voicestudio_host`, `voice_name_audio_url`; worker tick in the
  30s background loop (log-only).
- Frontend: `getWorkerNameAudioUrl` checked first at all 3 name-playback sites;
  host persisted to native on change with mount-time convergence.
- EVIDENCE: 11/11 `voice_pull` Rust tests (incl. loopback pull, wav-reject retry, embedded-migration); shared 34 + client 247 + server 170; cargo 275/275.

## Phase 4 — Host setup doc + VOICE_CLONING.md update (DONE 2026-09-12)
- `VOICE_CLONING.md`: auto-queue callout (§1), host requirements (LAN bind, Bea profile,
  host ffmpeg), automatic-flow rewrite (§5). Batch script stays as backfill.
- Superseded draft notes below retained for history (profile-id config, manifest patch,
  and wav-fallback ideas were replaced: profile is auto-discovered, worker clips resolve
  via asset URL outside the bundled manifest, non-mp3 is a loud retryable error).

## Original draft (superseded where it conflicts with the above)
- Enqueue in Rust user upsert: after successful insert/update of an INTERN/EMPLOYEE,
  upsert a PENDING job with the spoken-text normalizer port.
- Enqueue on rename too (name change → new PENDING job, old mp3 replaced on success).
(Draft details omitted — implementation landed as Phases 1–4 above; server-mode parity
in `server/src/setup.ts` intentionally skipped: the kiosk Rust backend owns the queue.)

## Acceptance gates
- [x] `npm run lint:oxlint`, `npm run typecheck`, `npm test` green.
  EVIDENCE 2026-09-12: lint exit 0, typecheck exit 0, `npm test` 17 files 170 tests pass.
- [x] `cargo test --manifest-path src-tauri/Cargo.toml` green (incl. new enqueue/worker tests).
  EVIDENCE 2026-09-12: 271 passed, 0 failed (8 new `voice_pull` tests).
- [x] No new dependencies in any `package.json`/`Cargo.toml`.
  EVIDENCE: reqwest/serde_json/chrono already in Cargo.toml; `@tauri-apps/api/core` already used.
- [ ] Register test intern with host offline → PENDING job, Piper speaks name, scan succeeds.
- [ ] Host online → mp3 on disk within 2 ticks, Tier 1 playback next scan.
- [ ] Wrong host address → Test Connection shows error, registration still succeeds.

## Risks
- VoiceStudio LAN bind defaults to localhost — doc the flag; Test Connection catches it.
- Bea profile id differs per host PC — make it a second settings field if a second host needs it.
- Kiosk disk growth trivial (~30–60 KB per name mp3).
