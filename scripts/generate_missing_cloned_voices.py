#!/usr/bin/env python3
"""
Regenerates missing or corrupt clips using the VoiceStudio Ma'am Bea profile (24000 Hz).
"""

import sys
import shutil
from pathlib import Path
from generate_cloned_voices import (
    PHRASE_CATALOG,
    get_voicestudio_bea_profile,
    generate_phrase_voicestudio,
    CLIENT_OUTPUT_BASE,
    TAURI_OUTPUT_BASE,
)

def main():
    profile_id = get_voicestudio_bea_profile()
    print("=" * 70)
    print(" Regenerating Cloned Bea Voice Clips via VoiceStudio")
    print(f" Profile ID: {profile_id}")
    print("=" * 70)

    regenerated = 0
    failed = 0
    skipped = 0

    for idx, item in enumerate(PHRASE_CATALOG, start=1):
        category = item["category"]
        slug = item["slug"]
        phrase = item["phrase"]
        client_mp3 = CLIENT_OUTPUT_BASE / category / f"{slug}.mp3"
        tauri_mp3 = TAURI_OUTPUT_BASE / category / f"{slug}.mp3"

        # Check if the MP3 is missing or suspiciously small
        needs_generation = False
        if not client_mp3.is_file() or client_mp3.stat().st_size < 1000:
            needs_generation = True

        if not needs_generation:
            skipped += 1
            print(f"[{idx}/{len(PHRASE_CATALOG)}] [SKIP] {category}/{slug}.mp3 (\"{phrase}\")")
            continue

        print(f"[{idx}/{len(PHRASE_CATALOG)}] [GENERATING] {category}/{slug}.mp3: \"{phrase}\"...")
        client_mp3.parent.mkdir(parents=True, exist_ok=True)
        tauri_mp3.parent.mkdir(parents=True, exist_ok=True)

        ok = generate_phrase_voicestudio(profile_id, phrase, client_mp3)
        if ok and client_mp3.is_file() and client_mp3.stat().st_size > 1000:
            shutil.copy2(client_mp3, tauri_mp3)
            regenerated += 1
            print(f"  ✓ Success: {client_mp3.stat().st_size} bytes")
        else:
            failed += 1
            print(f"  ✗ Failed for phrase: \"{phrase}\"", file=sys.stderr)

    print("\n" + "=" * 70)
    print(f" Generation complete: {regenerated} generated, {skipped} kept (already present), {failed} failed.")
    print("=" * 70)

if __name__ == "__main__":
    main()
