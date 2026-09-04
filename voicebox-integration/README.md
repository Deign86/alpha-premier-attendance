# Voicebox Name Pronunciation Integration Guide

This directory contains client integration examples and technical specifications for consuming employee name pronunciation overrides from the **Alpha Premier Attendance Voicebox API**.

---

## Overview

The Voicebox Names subsystem provides phonetic dictionaries, International Phonetic Alphabet (IPA) transcriptions, and pre-formatted SSML `<phoneme>` tags to enhance text-to-speech (TTS) playback quality during attendance scans, kiosk announcements, and external TTS pipelines.

---

## API Endpoints

### 1. `GET /api/voicebox/pronunciations`
Fetches all active pronunciation overrides.

- **Headers**:
  - `x-voicebox-key`: (Optional) Voicebox API key if authentication is configured.
- **Query Parameters**:
  - `key`: (Optional) API key passed via query string.
- **Response Format**:
  ```json
  {
    "success": true,
    "pronunciations": [
      {
        "employeeId": "EMP-001",
        "displayName": "Bea",
        "fullName": "Beatrice Alonzo",
        "phoneticSimple": "BEE-ah",
        "phoneticIpa": "ˈbiː.ə",
        "languageTag": "en-PH",
        "notes": "Cloned voice primary anchor"
      }
    ]
  }
  ```

---

### 2. `GET /api/voicebox/ssml?name={name}`
Returns pre-formatted W3C Speech Synthesis Markup Language (SSML) with IPA `<phoneme>` element for a specific name.

- **Query Parameters**:
  - `name`: (Required) Display name or full name to lookup (URL encoded).
  - `key`: (Optional) Voicebox API key.
- **Response Format**:
  ```json
  {
    "success": true,
    "name": "Bea",
    "ssml": "<phoneme alphabet=\"ipa\" ph=\"ˈbiː.ə\">Bea</phoneme>",
    "phoneticIpa": "ˈbiː.ə",
    "phoneticSimple": "BEE-ah"
  }
  ```
- **Fallback**: If the name does not have an IPA override in the database, `ssml` returns the plain escaped text name.

---

### 3. `GET /api/voicebox-names`
Returns all employees from the SQLite/apgbackup database with their pronunciation configuration status.

- **Response Format**:
  ```json
  {
    "success": true,
    "names": [
      {
        "employeeId": "EMP-001",
        "fullName": "Beatrice Alonzo",
        "firstName": "Beatrice",
        "lastName": "Alonzo",
        "displayName": "Bea",
        "hasPronunciation": true,
        "phoneticSimple": "BEE-ah",
        "phoneticIpa": "ˈbiː.ə",
        "languageTag": "en-PH",
        "notes": "Cloned voice reference"
      }
    ]
  }
  ```

---

### 4. `GET /api/voicebox-names/:employeeId`
Fetches the detailed record and pronunciation override for a single employee.

---

### 5. `POST /api/voicebox-names/:employeeId/pronunciation`
Creates or updates the pronunciation override for an employee.

- **Request Body**:
  ```json
  {
    "displayName": "Bea",
    "phoneticSimple": "BEE-ah",
    "phoneticIpa": "ˈbiː.ə",
    "languageTag": "en-PH",
    "notes": "Preferred short name"
  }
  ```
- **Response Format**:
  ```json
  {
    "success": true,
    "record": {
      "employeeId": "EMP-001",
      "displayName": "Bea",
      "phoneticSimple": "BEE-ah",
      "phoneticIpa": "ˈbiː.ə",
      "languageTag": "en-PH",
      "notes": "Preferred short name"
    }
  }
  ```

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BASE_URL` | Base URL of the running attendance server | `http://localhost:3001` |
| `VOICEBOX_KEY` | Optional API key required when endpoints are protected | `""` (Open/internal) |
| `APGBACKUP_DB_PATH` | Path to SQLite database file containing user & pronunciation tables | Local SQLite DB path |

---

## Recommended Caching Strategy

Because employee name pronunciations are infrequently modified:
1. **In-Memory Map**: Fetch the complete dictionary on client startup via `fetchAllPronunciations()`.
2. **Background Refresh**: Refresh the dictionary in the background every **5 to 15 minutes** (`setInterval`).
3. **Cache Hit**: Instant zero-latency lookups by lowercase display name (`map.get(name.toLowerCase())`).
4. **Cache Miss**: If a name is not present in cache, attempt a direct on-demand lookup or fallback immediately.

---

## Error Handling & Fallbacks

- **Network Failure**: If the Voicebox API is unreachable, integrations **must not block audio playback**. Instead, fall back to plain-text pronunciation using the un-annotated name string.
- **Missing Phoneme**: If an employee has no IPA transcription recorded, use their `displayName` or `phoneticSimple` directly.
- **SSML Escaping**: Always XML-escape name strings before injecting them into SSML envelopes:
  ```javascript
  name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  ```

---

## Cross-Origin Resource Sharing (CORS)

The server is configured with standard CORS headers (`Access-Control-Allow-Origin: *` or configured frontend origins) and allows `Content-Type` and `x-voicebox-key` request headers. If accessing from browser scripts on a different origin, include the `x-voicebox-key` header or append `?key=...` in the query string.

---

## Example Usage

### Node.js
```bash
node voicebox-integration/client-example.js
```

### PowerShell
```powershell
.\voicebox-integration\client-example.ps1 -BaseUrl "http://localhost:3001"
```
