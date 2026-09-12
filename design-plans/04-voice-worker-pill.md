# Plan 04 — Voice panel worker pill: unstack dot/text + align retry copy

- Status: DONE 2026-09-12 — pill override + `Retrying` copy; screenshot
  `14-voice-pill-proof` shows one-line pill with inline dot; voice panel + App
  tests pass; typecheck + oxlint clean
- Current commit: `1294222`
- Surface: Admin → Voice announcements → worker status facts row
- Owners: `client/src/voice-settings-panel.tsx` `:244–274` (facts row + pill);
  `client/src/styles.css` `.lan-facts` `:331–334`; header chip copy in
  `client/src/App.tsx` VoiceWorkerChip (`Retrying ${worker.retry}…`)

## Evidence (do not re-audit; verify before edit)

1. Tauri screenshot `05-voice-announcements` (this session): the `UP TO DATE`
   pill renders its green dot ABOVE the text (two stacked lines) instead of
   inline. Root cause: `styles.css:332` `.lan-facts span { display: grid; … }`
   matches EVERY span in the facts grid — including the `lan-state` pill span
   (`voice-settings-panel.tsx:264–272`), whose `lan-state` class
   (`inline-flex`) loses to the later, equally-specific grid rule.
2. Copy contradiction in the same task: retry state renders `Waiting` in the
   panel pill (:271) but `Retrying N…` in the Users-header chip for the same
   `workerStatus.retry`. One of them contradicts the other; the header chip is
   the established owner (also matches the worker's `RETRY` status).

## Change (two surgical edits, one surface; no new tokens)

1. CSS (`client/src/styles.css`, after :332): add
   `.lan-facts > span.lan-state { display: inline-flex; align-self: center;
   justify-self: start; }`
2. Copy (`client/src/voice-settings-panel.tsx:271`): `'Waiting'` → `'Retrying'`
   (pill then reads `Retrying`, matching the header chip's verb).

## Checks

- `npm test -w client -- src/voice-settings-panel.test.tsx src/App.test.tsx`
  exits 0.
- `npm run lint:oxlint` exits 0.
- Headful proof: screenshot Voice announcements — pill is one line, dot inline;
   set a retry state and confirm both surfaces read `Retrying`.

## Risks

- The `> span.lan-state` selector must not leak to other `.lan-facts` grids
  (Database panel has none — verify by screenshot `02`, unchanged).
