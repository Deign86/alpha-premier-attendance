import urllib.request
import json
import subprocess
from pathlib import Path

VOICESTUDIO_BASE = "http://127.0.0.1:3900"
REPO_ROOT = Path(__file__).resolve().parent.parent
CLIENT_OUTPUT_BASE = REPO_ROOT / "client" / "public" / "voices" / "bea"

def get_audio_duration_and_stats(wav_path):
    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration,size,bit_rate",
        "-of", "json",
        str(wav_path)
    ]
    try:
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True)
        data = json.loads(res.stdout)
        duration = float(data["format"].get("duration", 0))
        size = int(data["format"].get("size", 0))
        return duration, size
    except Exception as e:
        return 0.0, 0

def audit():
    from generate_cloned_voices import PHRASE_CATALOG

    print("=" * 80)
    print(" AUDITING VOICESTUDIO CLONED BEA AUDIO RESULTS")
    print("=" * 80)

    # 1. Fetch VoiceStudio history (optional; skipped when the endpoint is absent)
    try:
        req = urllib.request.urlopen(f"{VOICESTUDIO_BASE}/history?limit=200", timeout=10)
        hist_data = json.loads(req.read().decode())
        items = hist_data.get("items", [])
        print(f"Total items in VoiceStudio history: {len(items)}")
    except Exception as e:
        print(f"VoiceStudio history unavailable, auditing local files only ({e})")
        items = []

    # Count text occurrences in history
    history_by_text = {}
    for it in items:
        txt = it.get("text", "").strip()
        history_by_text.setdefault(txt, []).append(it)

    print("\n--- History Duplicate Check ---")
    for txt, it_list in history_by_text.items():
        if len(it_list) > 1:
            print(f"DUPLICATE in history ({len(it_list)}x): \"{txt}\"")
            for x in it_list:
                print(f"    ID: {x.get('id')} | Status: {x.get('status')} | Duration: {x.get('duration')}s")

    # 2. Check each phrase in PHRASE_CATALOG against the generated wav files on disk
    print("\n--- File Integrity & Duration Check ---")
    issues = []
    total = len(PHRASE_CATALOG)
    valid_count = 0

    for idx, item in enumerate(PHRASE_CATALOG, start=1):
        category = item["category"]
        slug = item["slug"]
        phrase = item["phrase"]
        wav_path = CLIENT_OUTPUT_BASE / category / f"{slug}.wav"

        if not wav_path.is_file():
            print(f"[{idx}/{total}] MISSING FILE: {category}/{slug}.wav (\"{phrase}\")")
            issues.append((category, slug, phrase, "Missing file"))
            continue

        dur, sz = get_audio_duration_and_stats(wav_path)

        # Sanity check on duration
        # Very short greetings like "Goodbye," or "Good morning," might be 0.5s - 1.5s
        # Longer sentences should be > 1.5s
        word_count = len(phrase.split())
        expected_min_dur = 0.4 if word_count <= 2 else (0.8 if word_count <= 5 else 1.5)

        status_flag = "OK"
        if sz < 1000:
            status_flag = "CORRUPT/EMPTY"
            issues.append((category, slug, phrase, f"Size too small: {sz} bytes"))
        elif dur < expected_min_dur:
            status_flag = "SUSPICIOUSLY SHORT (Truncated?)"
            issues.append((category, slug, phrase, f"Duration too short: {dur:.2f}s for {word_count} words"))
        elif dur > 20.0:
            status_flag = "SUSPICIOUSLY LONG (Hallucinated?)"
            issues.append((category, slug, phrase, f"Duration too long: {dur:.2f}s"))
        else:
            valid_count += 1

        print(f"[{idx}/{total}] [{status_flag}] {category}/{slug}.wav | {dur:.2f}s | {sz}B | \"{phrase}\"")

    print("\n" + "=" * 80)
    print(f"Summary: {valid_count}/{total} files valid, {len(issues)} issues detected.")
    if issues:
        print("\nIdentified Issues:")
        for cat, slg, phr, iss in issues:
            print(f"  - [{cat}/{slg}] \"{phr}\": {iss}")
    print("=" * 80)

if __name__ == "__main__":
    audit()
