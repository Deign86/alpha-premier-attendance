# Voice Cloning Architecture & Maintainer Guide: "Ma'am Bea" (VoiceStudio + Hybrid Splicing)

## Overview & Architecture

Alpha Premier Attendance features a zero-latency, offline voice profile (**"Ma'am Bea"**) for kiosk attendance greetings, bathroom key checkouts, admin assist alerts, and system error feedback.

To deliver studio-quality voice cloning without demanding GPU hardware or high-latency neural inference on the low-powered kiosk PC, the system implements a **Two-Tier Hybrid Playback Engine**:

```
                                  [ RFID Card Scanned ]
                                            │
                                            ▼
                           ┌─────────────────────────────────┐
                           │ TTS Engine: "cloned-bea"?       │
                           └────────────────┬────────────────┘
                                            │ YES
                                            ▼
                           ┌─────────────────────────────────┐
                           │ Is user's personId in Manifest? │
                           └────────┬───────────────┬────────┘
                                    │               │
                            YES (In Cache)     NO (Future / New)
                                    │               │
                                    ▼               ▼
                       ┌──────────────────────┐ ┌──────────────────────┐
                       │  Tier 1: 100% Cloned │ │  Tier 2: Hybrid Splic│
                       ├──────────────────────┤ ├──────────────────────┤
                       │ Cloned Bea Prefix    │ │ Cloned Bea Prefix    │
                       │          +           │ │          +           │
                       │ Cloned Bea Name      │ │ Live Piper Name      │
                       │          +           │ │          +           │
                       │ Cloned Bea Suffix    │ │ Cloned Bea Suffix    │
                       └──────────────────────┘ └──────────────────────┘
```

1. **Tier 1 — Existing Active Interns & Employees (100% Cloned Voice)**:
   Names of existing personnel are pre-rendered into individual audio clips (`names/<personId>.wav`) in Ma'am Bea's voice using VoiceStudio on the admin machine. When they scan, the kiosk plays:
   $$\text{Cloned Bea Prefix} \longrightarrow \text{Cloned Bea Name} \longrightarrow \text{Cloned Bea Suffix}$$
2. **Tier 2 — Future Registrations & Dynamic Names (Zero-Delay Hybrid Splicing)**:
   For interns or employees enrolled *after* batch generation, the kiosk automatically bridges speech at runtime using local Piper TTS without manual generation:
   $$\text{Cloned Bea Prefix} \longrightarrow \text{Live Piper Dynamic Name} \longrightarrow \text{Cloned Bea Suffix}$$

---

## 1. Prerequisites for Voice Generation (Admin / Dev PC Only)

> [!IMPORTANT]
> Voice generation is performed **exclusively on the admin/developer machine**. The kiosk PC **never runs VoiceStudio or cloning inference**.

### Admin Hardware & Software Requirements
- **OS**: Windows 10/11 x64
- **GPU**: NVIDIA RTX 3050/4050 or higher (at least 4–6 GB VRAM recommended)
- **VoiceStudio**: Installed and running locally ([`debpalash/VoiceStudio`](https://github.com/debpalash/VoiceStudio))
- **VoiceStudio API Endpoint**: `http://127.0.0.1:3900`
- **Active Voice Profile**: `"Ma'am Bea"` (Profile ID: `1b3e828b`)

### Reference Audio Locations (Admin PC Only)
- `resources/voices/bea/main.wav` (Neutral/Welcoming greeting tone, $F_0 \approx 130\text{ Hz}$)
- `resources/voices/bea/neutral.wav` (Clear alert tone for scan errors)
- `resources/voices/bea/warm.wav` (Warm tone for bathroom checkouts)

---

## 2. Step-by-Step: How to Generate Cloned Names for New Interns & Employees

Follow these steps whenever a new cohort of interns arrives or new employees are registered.

### Step 1: Start VoiceStudio on the Admin PC
1. Launch VoiceStudio (or ensure the backend is running on port `3900`).
2. Confirm the server is reachable by opening `http://127.0.0.1:3900/profiles` in a browser or running:
   ```bash
   curl http://127.0.0.1:3900/profiles
   ```
3. Verify that the profile named `"Ma'am Bea"` is listed.

### Step 2: Run a Dry Run to Inspect Names & Pronunciations
Preview which users will be generated, review their spoken phonetics, and check for missing audio files:

```bash
npm run voice:generate-existing-names -- --dry-run
```

*Output example:*
```
[Person ID: APG-2026-115] INTERN: "Ma. Teresa Carandang" -> Spoken: "Maria Teresa Carandang"
  [DRY-RUN] Would generate clip via VoiceStudio -> /voices/bea/names/APG-2026-115.wav
```

### Step 3: Run Batch Generation for Missing Names
Generate voice clips only for newly enrolled users who do not yet have cached audio:

```bash
npm run voice:generate-existing-names -- --missing-only
```

*What the generator does:*
1. Connects to Google Sheets / SQLite database and discovers all active `INTERN` and `EMPLOYEE` records.
2. Normalizes full names for Filipino/English speech phonetics.
3. Sends generation requests to VoiceStudio (`Ma'am Bea` profile `1b3e828b`).
4. Saves 16-bit 24kHz/48kHz PCM WAV files to:
   - `client/public/voices/bea/names/<personId>.wav`
   - `src-tauri/resources/voices/bea/names/<personId>.wav`
   - `client/dist/voices/bea/names/<personId>.wav`
5. Computes SHA-256 hashes and writes [`bea-name-manifest.json`](file:///c:/Users/Deign/Downloads/alpha-premier-attendance/client/public/voices/bea/bea-name-manifest.json).

### Step 4: Audit and Verify Generated Audio Files
To check audio durations and file integrity of the generated clips:

```bash
npm run voice:audit
```

*Note on generation scripts*:
- `generate_cloned_voices.py` (`npm run generate:voices`): Canonical generator for the 50 master fixed kiosk announcement phrases.
- `generate_existing_intern_names.ts` (`npm run voice:generate-existing-names`): Canonical generator for employee and intern dynamic name clips.
- `audit_voicebox_results.py` (`npm run voice:audit`): Canonical QA and duration audit tool.
- One-off bootstrap and migration scripts (`setup_voicebox_bea.py`, `generate_backup_names.py`, `verify_backup_cloned_names.py`) are archived under [`scripts/archive/`](file:///c:/Users/Deign/Downloads/alpha-premier-attendance/scripts/archive/).

### Step 5: Force Regenerating a Specific User's Name
If an employee's name was misspelled or needs pronunciation adjustment:

```bash
npm run voice:generate-existing-names -- --person-id APG-2026-102 --force
```

---

## 3. Pronunciation Normalization & Phonics Engine

The script automatically applies Philippine phonetics rules via `normalizePronunciation()`:

| Raw Database Name | Normalized Spoken Text | Transformation Rule |
| :--- | :--- | :--- |
| `Ma. Ellaine Zapico` | `Maria Ellaine Zapico` | Expands abbreviation `"Ma."` to `"Maria"` |
| `Deign Grey O. Lazaro` | `Deign Grey Lazaro` | Cleans middle initial dot to prevent awkward `"dot"` pauses |
| `Ar-jee Felizarte` | `Arjee Felizarte` | Removes hyphens in compound first names |
| `Juan Dela Cruz, Jr.` | `Juan Dela Cruz Junior` | Expands suffix `"Jr."` / `"Sr."` to full spoken words |

### Adding Custom Pronunciation Overrides
If a name has an irregular pronunciation (e.g. non-standard spelling or foreign surname), add a custom rule in [`scripts/generate_existing_intern_names.ts`](file:///c:/Users/Deign/Downloads/alpha-premier-attendance/scripts/generate_existing_intern_names.ts) under `CUSTOM_PRONUNCIATION_OVERRIDES`:

```typescript
const CUSTOM_PRONUNCIATION_OVERRIDES: Record<string, string> = {
  // 'PERSON_ID': 'Phonetic Spoken Name'
  'APG-2026-999': 'Jan-Michael',
};
```

---

## 4. How to Deploy & Provision New Audio to the Kiosk

### Method A: Regular Application Update (Recommended)
1. Run `npm run tauri:build` on the dev PC.
2. The generated `names/` audio folder and `bea-name-manifest.json` are automatically bundled inside Tauri resources.
3. Install the updated `.msi` / `.exe` on the kiosk.

### Method B: Hot-Copying Without App Reinstallation
You can update the kiosk's name audio files live while the kiosk is running:
1. Copy the `names/` folder and `bea-name-manifest.json` from the admin PC:
   - Source: `src-tauri/resources/voices/bea/names/` and `bea-name-manifest.json`
   - Destination: `<Kiosk App Directory>/resources/voices/bea/names/`
2. Restart the app. The kiosk reloads `bea-name-manifest.json` on startup.

---

## 5. What Happens for Future Registrations? (Hybrid Fallback)

Maintainers do **not** need to generate cloned audio immediately for every single newly registered cardholder:
- If an unknown or future user scans their RFID card, the app checks `bea-name-manifest.json`.
- When the name is not in the cache, the app immediately plays:
  1. Cloned Bea greeting: `"Good morning,"`
  2. Local Piper TTS: `"<Full Name>"` (via fast offline C++ binary)
  3. Cloned Bea status: `"Your time in has been recorded."`
- The intern/employee is welcomed seamlessly with zero delay.
- At the start of the next payroll cutoff or semester, the admin can run `npm run voice:generate-existing-names -- --missing-only` to upgrade those users to fully cloned voices.

---

## 6. Privacy, Consent & Data Revocation Runbook

> [!IMPORTANT]
> Cloned voice models and employee recordings must comply with company privacy guidelines and explicit individual consent.
>
> All generated name audio (`voices/bea/names/`), manifests (`bea-name-manifest.json`), and raw recordings are ignored by Git (`.gitignore`) and are never committed to version control.

### Complete Revocation Procedure
If Ma'am Bea or an employee revokes consent to use their cloned voice profile:

1. **Switch Default Voice to Piper**:
   In kiosk Settings $\rightarrow$ Voice Announcements, set the Engine to **Piper TTS** or **Auto (Offline)**.
2. **Purge Cloned Audio Cache**:
   ```powershell
   Remove-Item -Recurse -Force client/public/voices/bea
   Remove-Item -Recurse -Force src-tauri/resources/voices/bea
   Remove-Item -Recurse -Force client/dist/voices/bea
   ```
3. **Delete Raw Reference Recordings**:
   Delete `resources/voices/bea/` and any reference files in `Downloads/Music/`.
4. **Delete VoiceStudio Profile**:
   Open VoiceStudio, select the `"Ma'am Bea"` profile, and delete it.

---

## 7. Troubleshooting & Verification

| Issue | Root Cause | Solution |
| :--- | :--- | :--- |
| `Error connecting to VoiceStudio` | VoiceStudio backend is down | Launch VoiceStudio; verify port `3900` with `curl http://127.0.0.1:3900/profiles` |
| `Generation failed` | VoiceStudio profile missing or backend error | Confirm the `Ma'am Bea` profile exists in VoiceStudio and retry |
| `Name pronounced with "dot"` | Middle initial not cleaned | Ensure name is run through `normalizePronunciation()` or add to `CUSTOM_PRONUNCIATION_OVERRIDES` |
| `Kiosk plays Piper name instead of Bea` | Missing manifest entry or missing WAV file | Check `bea-name-manifest.json` and ensure `names/<personId>.wav` exists in resources |

### Verification Commands
```bash
# Pre-flight environment check
npm run doctor:mcp

# Full test suite (260+ tests)
npm test

# Type & contract verification
npm run lint:oxlint
npm run typecheck
```
