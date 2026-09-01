#!/usr/bin/env python3
"""
Regenerates all 22050 Hz fallback placeholder clips using Voicebox Qwen-TTS 1.7B Ma'am Bea profile (24000 Hz).
"""

import sys
import wave
import shutil
from pathlib import Path
from generate_cloned_voices import (
    PHRASE_CATALOG,
    get_voicebox_bea_profile,
    generate_phrase_voicebox,
    CLIENT_OUTPUT_BASE,
    TAURI_OUTPUT_BASE,
)

def main():
    profile_id = get_voicebox_bea_profile()
    print("=" * 70)
    print(" Regenerating Cloned Bea Voice Clips via Voicebox AI Studio")
    print(f" Profile ID: {profile_id}")
    print("=" * 70)

    regenerated = 0
    failed = 0
    skipped = 0

    for idx, item in enumerate(PHRASE_CATALOG, start=1):
        category = item["category"]
        slug = item["slug"]
        phrase = item["phrase"]
        client_wav = CLIENT_OUTPUT_BASE / category / f"{slug}.wav"
        tauri_wav = TAURI_OUTPUT_BASE / category / f"{slug}.wav"

        # Check if file is missing, empty, or has framerate != 24000 Hz
        needs_generation = False
        if not client_wav.is_file() or client_wav.stat().st_size < 1000:
            needs_generation = True
        else:
            try:
                with wave.open(str(client_wav), "rb") as w:
                    rate = w.getframerate()
                    if rate != 24000:
                        needs_generation = True
            except Exception:
                needs_generation = True

        if not needs_generation:
            skipped += 1
            print(f"[{idx}/{len(PHRASE_CATALOG)}] [SKIP 24kHz] {category}/{slug}.wav (\"{phrase}\")")
            continue

        print(f"[{idx}/{len(PHRASE_CATALOG)}] [GENERATING] {category}/{slug}.wav: \"{phrase}\"...")
        client_wav.parent.mkdir(parents=True, exist_ok=True)
        tauri_wav.parent.mkdir(parents=True, exist_ok=True)

        ok = generate_phrase_voicebox(profile_id, phrase, client_wav)
        if ok and client_wav.is_file() and client_wav.stat().st_size > 1000:
            shutil.copy2(client_wav, tauri_wav)
            regenerated += 1
            try:
                with wave.open(str(client_wav), "rb") as w:
                    print(f"  ✓ Success: {client_wav.stat().st_size} bytes @ {w.getframerate()} Hz")
            except Exception:
                print(f"  ✓ Success: {client_wav.stat().st_size} bytes")
        else:
            failed += 1
            print(f"  ✗ Failed for phrase: \"{phrase}\"", file=sys.stderr)

    print("\n" + "=" * 70)
    print(f" Generation complete: {regenerated} generated, {skipped} kept (already 24kHz), {failed} failed.")
    print("=" * 70)

if __name__ == "__main__":
    main()
