# Voicebox Name Pronunciations — HR & Admin Guide

The **Voicebox Name Pronunciations** manager allows HR and administrative staff to customize how employee names are pronounced by the kiosk's text-to-speech (TTS) voice announcements during clock-ins and clock-outs.

---

## Why Use Pronunciation Overrides?

Text-to-speech engines can sometimes mispronounce Filipino, Spanish, foreign, or unusually spelled names. Common issues include:
- Incorrect syllable stress (e.g., *Car-LOS* instead of *CAR-los*).
- Misread vowel sounds (e.g., pronouncing *Bea* as *B-E-A* instead of *BEE-ah*).
- Silent letters or regional accents.
- Preference for nicknames over legal first names during morning greetings.

By defining **Simple Phonetics** and **IPA (International Phonetic Alphabet)** overrides, the system ensures accurate, natural greetings for every team member.

---

## How to Access the Pronunciation Manager

1. Open the **Admin Panel** (`/admin`).
2. Unlock the admin session using your Admin PIN or Master RFID Card.
3. Select the **Voice announcements** tab in the navigation bar.
4. Scroll to the **Voicebox Name Pronunciations** card.
5. Click **Open Pronunciation Manager**.
   *(Direct URL shortcut: append `#/voicebox-names` to the application URL).*

---

## How to Manage Names in the UI

### 1. Searching & Filtering
- **Search Bar**: Type any part of an employee's full name, display name, or employee ID (e.g., `EMP-003` or `Carlos`).
- **Filter Tabs**:
  - **All**: Displays all employees in the database.
  - **Configured**: Shows only employees who already have custom pronunciation overrides.
  - **Missing**: Highlights employees without custom overrides so you can prioritize configuring them.

### 2. Editing an Employee's Pronunciation
Click the **Edit** button on any employee row to open the **Voice Name Editor** modal.

The editor provides:
- **Spoken Display Name**: The name greeting spoken by the voice (e.g., `Bea` instead of `Beatrice`).
- **Language / Accent Tag**: Dialect tag (`en-PH` for Philippine English, `fil-PH` for Filipino/Tagalog, `en-US`, or `en-GB`).
- **Simple Phonetic Guide**: Human-readable guide with capitalized stress.
- **IPA Transcription**: Precise phonetic transcriptions using standard IPA symbols.
- **On-Screen IPA Keyboard**: One-click insertion of vowels, consonants, and stress markers.
- **Live TTS Audio Preview**: Real-time syllable breakdown pill tags and preview cards.

---

## Guide: Writing Simple Phonetic Guides

Simple phonetics break names into intuitive syllables separated by **hyphens (`-`)**.

### Rules:
1. **Hyphens between syllables**: Separate every spoken syllable with a dash (e.g., `kar-LOHS`).
2. **Capitalize the stressed syllable**: Make the louder/emphasized syllable all-caps (e.g., `BEE-ah`, `mah-REE-ah`).
3. **Use phonetic spelling**: Spell syllables the way they sound in English:
   - `AY` for long A (e.g., *Jane* -> `JAYN`)
   - `EE` for long E (e.g., *Bea* -> `BEE-ah`)
   - `EYE` for long I (e.g., *Mike* -> `MYK` or `MAYK`)
   - `OH` for long O (e.g., *Joe* -> `JOH`)
   - `OO` for long U (e.g., *Lou* -> `LOO`)
   - `uh` for schwa / short neutral vowel (e.g., *Alonzo* -> `uh-LON-zoh`)

### Examples:
| Employee Name | Display Name | Simple Phonetic |
|---------------|--------------|-----------------|
| Beatrice Alonzo | Bea | `BEE-ah` |
| Carlos Mendoza | Carlos | `kar-LOHS` |
| Miguel Tan | Miguel | `mee-GEL` |
| Angelica Reyes | Angel | `AYN-jel` |
| Christian Cruz | Ian | `EE-yahn` |

---

## Guide: Writing IPA Transcriptions

The International Phonetic Alphabet (IPA) provides exact acoustic precision across neural speech engines.

### On-Screen IPA Keyboard:
Click any symbol on the on-screen keyboard to insert it directly into the IPA transcription box at your cursor position:
- **Vowels**: `i`, `y`, `e`, `ø`, `ɛ`, `a`, `ɶ`, `ɔ`, `o`, `ʊ`, `u`, `ɨ`, `ʉ`, `ə`, `ɐ`
- **Consonants**: `p`, `b`, `t`, `d`, `k`, `g`, `m`, `n`, `ŋ`, `f`, `v`, `θ`, `ð`, `s`, `z`, `ʃ`, `ʒ`, `h`, `l`, `r`, `ɾ`, `ɹ`, `j`, `w`
- **Stress & Syllables**:
  - `ˈ` : Primary stress mark (placed immediately *before* the stressed syllable, e.g. `/ˈbiː.ə/`).
  - `ˌ` : Secondary stress mark.
  - `.` : Syllable boundary marker (e.g. `/kaɾ.ˈlos/`).
  - `-` : Hyphen marker.

### Common Filipino & Philippine English IPA Patterns:
- Hard *ng* sound: `ŋ` (e.g. *Ng* -> `ŋ`)
- Flapped *r*: `ɾ` (e.g. *Maria* -> `ma.ˈɾiː.a`)
- Glottal stop: `ʔ` or syllable break `.`
- Long vowel: `ː` (e.g. `iː`, `uː`)

---

## How Local TTS Consumes the Data

1. **Zero-Cloud & 100% Offline**:
   - All speech synthesis executes entirely on the local client machine using the Piper neural voice engine (ONNX) or Ma'am Bea cloned voice clips.
   - No external cloud requests or internet connection are required.
2. **Automatic SSML Encoding**:
   - When an employee scans their RFID card, the system queries their configured IPA phoneme transcription.
   - If an IPA transcription exists, it is sent to the TTS engine formatted as:
     ```xml
     <phoneme alphabet="ipa" ph="ˈbiː.ə">Bea</phoneme>
     ```
   - If no IPA transcription exists, the system uses the `displayName` or simple phonetic guide.
3. **Instant Playback**:
   - Spoken greetings trigger immediately with sub-50ms latency upon valid card detection.
