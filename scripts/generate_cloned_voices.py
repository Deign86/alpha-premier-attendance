#!/usr/bin/env python3
"""
Alpha Premier Attendance — Voicebox AI Studio Voice Generation.
Clean, deduplicated master catalog for "Ma'am Bea" Zero-Shot Voice Cloning.
"""

import os
import sys
import json
import time
import shutil
import urllib.request
import urllib.error
from pathlib import Path

VOICEBOX_BASE = "http://127.0.0.1:17493"
REPO_ROOT = Path(__file__).resolve().parent.parent
CLIENT_OUTPUT_BASE = REPO_ROOT / "client" / "public" / "voices" / "bea"
TAURI_OUTPUT_BASE = REPO_ROOT / "src-tauri" / "resources" / "voices" / "bea"

# Deduplicated Master Phrase Catalog
PHRASE_CATALOG = [
    # --- 1. Hybrid Splicing Carrier Prefixes (Played before dynamic intern name) ---
    {
        "category": "attendance",
        "slug": "good-morning",
        "phrase": "Good morning,",
        "tone": "main",
    },
    {
        "category": "attendance",
        "slug": "good-afternoon",
        "phrase": "Good afternoon,",
        "tone": "main",
    },
    {
        "category": "attendance",
        "slug": "good-evening",
        "phrase": "Good evening,",
        "tone": "main",
    },
    {
        "category": "attendance",
        "slug": "goodbye",
        "phrase": "Goodbye,",
        "tone": "main",
    },
    {
        "category": "attendance",
        "slug": "attendance-recorded-for",
        "phrase": "Attendance recorded for",
        "tone": "main",
    },
    {
        "category": "attendance",
        "slug": "thank-you-great-day",
        "phrase": "Thank you, and have a great day.",
        "tone": "main",
    },

    # --- 2. Hybrid Splicing Suffixes & Full Standalone Announcements ---
    {
        "category": "attendance",
        "slug": "time-in-standard",
        "phrase": "Your time in has been recorded.",
        "tone": "main",
    },
    {
        "category": "attendance",
        "slug": "time-in-first-arrival",
        "phrase": "Your time in has been recorded. You are the first arrival today.",
        "tone": "main",
    },
    {
        "category": "attendance",
        "slug": "time-in-grace",
        "phrase": "Your time in has been recorded. You made it within the grace period.",
        "tone": "main",
    },
    {
        "category": "attendance",
        "slug": "time-in-grace-first-arrival",
        "phrase": "Your time in has been recorded. You made it within the grace period. You are the first arrival today.",
        "tone": "main",
    },
    {
        "category": "attendance",
        "slug": "time-in-late",
        "phrase": "Your time in has been recorded. You are late.",
        "tone": "main",
    },
    {
        "category": "attendance",
        "slug": "time-in-late-first-arrival",
        "phrase": "Your time in has been recorded. You are late. You are the first arrival today.",
        "tone": "main",
    },
    {
        "category": "attendance",
        "slug": "time-in-assisted-standard",
        "phrase": "Your assisted time in has been recorded.",
        "tone": "main",
    },
    {
        "category": "attendance",
        "slug": "time-in-assisted-first-arrival",
        "phrase": "Your assisted time in has been recorded. You are the first arrival today.",
        "tone": "main",
    },
    {
        "category": "attendance",
        "slug": "time-in-assisted-grace",
        "phrase": "Your assisted time in has been recorded. You made it within the grace period.",
        "tone": "main",
    },
    {
        "category": "attendance",
        "slug": "time-in-assisted-grace-first-arrival",
        "phrase": "Your assisted time in has been recorded. You made it within the grace period. You are the first arrival today.",
        "tone": "main",
    },
    {
        "category": "attendance",
        "slug": "time-in-assisted-late",
        "phrase": "Your assisted time in has been recorded. You are late.",
        "tone": "main",
    },
    {
        "category": "attendance",
        "slug": "time-in-assisted-late-first-arrival",
        "phrase": "Your assisted time in has been recorded. You are late. You are the first arrival today.",
        "tone": "main",
    },
    {
        "category": "attendance",
        "slug": "time-out-standard",
        "phrase": "Your time out has been recorded.",
        "tone": "main",
    },
    {
        "category": "attendance",
        "slug": "time-out-late-timeout",
        "phrase": "Your time out was recorded after office hours. Manual correction is required.",
        "tone": "main",
    },
    {
        "category": "attendance",
        "slug": "time-out-assisted-standard",
        "phrase": "Your assisted time out has been recorded.",
        "tone": "main",
    },
    {
        "category": "attendance",
        "slug": "time-out-assisted-late-timeout",
        "phrase": "Your assisted time out was recorded after office hours. Manual correction is required.",
        "tone": "main",
    },

    # --- 3. Bathroom Key Logging (Single Static Files) ---
    {
        "category": "bathroom",
        "slug": "bathroom-key-checked-out-15min",
        "phrase": "Your bathroom key has been checked out. Please return it within fifteen minutes.",
        "tone": "warm",
    },
    {
        "category": "bathroom",
        "slug": "checkout-male",
        "phrase": "Male bathroom key checked out.",
        "tone": "warm",
    },
    {
        "category": "bathroom",
        "slug": "checkout-female",
        "phrase": "Female bathroom key checked out.",
        "tone": "warm",
    },
    {
        "category": "bathroom",
        "slug": "return-male",
        "phrase": "Male bathroom key returned.",
        "tone": "warm",
    },
    {
        "category": "bathroom",
        "slug": "return-female",
        "phrase": "Female bathroom key returned.",
        "tone": "warm",
    },

    # --- 4. Admin Assist Recognition ---
    {
        "category": "admin-assist",
        "slug": "admin-assist-prompt",
        "phrase": "Admin assist card recognized. Please select an employee.",
        "tone": "warm",
    },

    # --- 5. Scan Errors and Warnings ---
    {
        "category": "scan-error",
        "slug": "sorry-card-not-recognized",
        "phrase": "Sorry, that card wasn't recognized. Please try scanning again.",
        "tone": "neutral",
    },
    {
        "category": "scan-error",
        "slug": "bathroom-key-in-use-male",
        "phrase": "The male bathroom key is currently in use.",
        "tone": "neutral",
    },
    {
        "category": "scan-error",
        "slug": "bathroom-key-in-use-female",
        "phrase": "The female bathroom key is currently in use.",
        "tone": "neutral",
    },
    {
        "category": "scan-error",
        "slug": "bathroom-key-in-use",
        "phrase": "The bathroom key is currently in use.",
        "tone": "neutral",
    },
    {
        "category": "scan-error",
        "slug": "card-not-registered",
        "phrase": "This card is not registered.",
        "tone": "neutral",
    },
    {
        "category": "scan-error",
        "slug": "employee-record-inactive",
        "phrase": "Employee record is inactive.",
        "tone": "neutral",
    },
    {
        "category": "scan-error",
        "slug": "card-scanned-too-recently",
        "phrase": "Card scanned too recently. Please wait.",
        "tone": "neutral",
    },
    {
        "category": "scan-error",
        "slug": "admin-card-not-allowed",
        "phrase": "Admin cards cannot check out bathroom keys.",
        "tone": "neutral",
    },
    {
        "category": "scan-error",
        "slug": "admin-card-requires-selection",
        "phrase": "Admin card requires employee selection.",
        "tone": "neutral",
    },
    {
        "category": "scan-error",
        "slug": "attendance-already-completed",
        "phrase": "Attendance is already completed for today.",
        "tone": "neutral",
    },
    {
        "category": "scan-error",
        "slug": "attendance-timed-out-correction",
        "phrase": "Attendance timed out after office hours and is pending manual correction.",
        "tone": "neutral",
    },
    {
        "category": "scan-error",
        "slug": "service-unavailable",
        "phrase": "Attendance service is temporarily unavailable.",
        "tone": "neutral",
    },
    {
        "category": "scan-error",
        "slug": "attendance-conflict",
        "phrase": "Attendance conflict. Please try again.",
        "tone": "neutral",
    },
    {
        "category": "scan-error",
        "slug": "scan-generic-error",
        "phrase": "Scan could not be processed.",
        "tone": "neutral",
    },

    # --- 6. General / Test ---
    {
        "category": "general",
        "slug": "test-voice",
        "phrase": "Voice announcements are working correctly.",
        "tone": "main",
    },
]


def get_voicebox_bea_profile():
    try:
        req = urllib.request.urlopen(f"{VOICEBOX_BASE}/profiles")
        profiles = json.loads(req.read().decode())
        for p in profiles:
            if "bea" in p["name"].lower():
                return p["id"]
    except Exception as e:
        print(f"Error connecting to Voicebox at {VOICEBOX_BASE}: {e}", file=sys.stderr)
    return None


def generate_phrase_voicebox(profile_id: str, phrase: str, out_file: Path) -> bool:
    payload = json.dumps({
        "profile_id": profile_id,
        "text": phrase,
        "engine": "qwen",
        "model_size": "1.7B",
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{VOICEBOX_BASE}/generate",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req) as res:
            gen_data = json.loads(res.read().decode())
            gen_id = gen_data["id"]
    except Exception as e:
        print(f"  Failed to start generation: {e}", file=sys.stderr)
        return False

    # Poll status
    for _ in range(90):
        time.sleep(2)
        try:
            req = urllib.request.urlopen(f"{VOICEBOX_BASE}/history/{gen_id}")
            hist = json.loads(req.read().decode())
            status = hist.get("status")
            if status == "completed":
                audio_url = f"{VOICEBOX_BASE}/audio/{gen_id}"
                urllib.request.urlretrieve(audio_url, out_file)
                return out_file.is_file() and out_file.stat().st_size > 100
            elif status == "failed":
                print(f"  Voicebox error for '{phrase}': {hist.get('error')}", file=sys.stderr)
                return False
        except Exception:
            pass

    return False


def main():
    print("=" * 70)
    print(" Alpha Premier Attendance — Deduplicated Voicebox Qwen-TTS 1.7B")
    print(" Master Catalog: 43 Distinct Announcement Phrases")
    print("=" * 70)

    profile_id = get_voicebox_bea_profile()
    if not profile_id:
        print("Could not find Ma'am Bea profile in Voicebox.", file=sys.stderr)
        sys.exit(1)

    CLIENT_OUTPUT_BASE.mkdir(parents=True, exist_ok=True)
    TAURI_OUTPUT_BASE.mkdir(parents=True, exist_ok=True)

    manifest = {
        "version": "6.0.0",
        "engine": "voicebox-qwen-1.7B-cuda-cloned",
        "voice": "bea",
        "voicebox_profile_id": profile_id,
        "segments": {},
        "phrases": {},
    }

    generated_count = 0

    for idx, item in enumerate(PHRASE_CATALOG, start=1):
        category = item["category"]
        slug = item["slug"]
        phrase = item["phrase"]
        tone = item["tone"]

        cat_dir_client = CLIENT_OUTPUT_BASE / category
        cat_dir_client.mkdir(parents=True, exist_ok=True)
        cat_dir_tauri = TAURI_OUTPUT_BASE / category
        cat_dir_tauri.mkdir(parents=True, exist_ok=True)

        out_file_client = cat_dir_client / f"{slug}.wav"
        out_file_tauri = cat_dir_tauri / f"{slug}.wav"
        rel_url = f"/voices/bea/{category}/{slug}.wav"
        rel_tauri = f"voices/bea/{category}/{slug}.wav"

        print(f"[{idx}/{len(PHRASE_CATALOG)}] [{category}] {slug}: \"{phrase}\"")

        # Generate only if missing or too small
        if not (out_file_client.is_file() and out_file_client.stat().st_size > 1000):
            success = generate_phrase_voicebox(profile_id, phrase, out_file_client)
            if success and out_file_client.is_file():
                print(f"  ✓ Generated ({out_file_client.stat().st_size} bytes)")
            else:
                print(f"  ✗ Generation failed for: {phrase}", file=sys.stderr)
        else:
            print(f"  ✓ Already exists ({out_file_client.stat().st_size} bytes)")

        if out_file_client.is_file() and out_file_client.stat().st_size > 1000:
            shutil.copy2(out_file_client, out_file_tauri)
            generated_count += 1
            manifest["phrases"][phrase] = rel_url
            manifest["segments"][slug] = {
                "phrase": phrase,
                "category": category,
                "url": rel_url,
                "tauri_path": rel_tauri,
                "tone": tone,
            }

    # Save manifests
    manifest_client = CLIENT_OUTPUT_BASE / "manifest.json"
    manifest_tauri = TAURI_OUTPUT_BASE / "manifest.json"

    with open(manifest_client, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    with open(manifest_tauri, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    print("\n" + "=" * 70)
    print(f"Deduplicated Catalog Synchronized: {generated_count}/{len(PHRASE_CATALOG)} clips ready.")
    print("=" * 70)


if __name__ == "__main__":
    main()
