import zipfile
import sqlite3
import tempfile
import os
import json
import time
import urllib.request
import hashlib
from pathlib import Path

VOICEBOX_BASE = "http://127.0.0.1:17493"
BACKUP_PATH = r"C:\Users\Deign\Downloads\attendance-backup-20260831-050918.apbackup"
REPO_ROOT = Path(__file__).resolve().parent.parent

CLIENT_NAMES_DIR = REPO_ROOT / "client" / "public" / "voices" / "bea" / "names"
TAURI_NAMES_DIR = REPO_ROOT / "src-tauri" / "resources" / "voices" / "bea" / "names"
DIST_NAMES_DIR = REPO_ROOT / "client" / "dist" / "voices" / "bea" / "names"

CLIENT_MANIFEST = REPO_ROOT / "client" / "public" / "voices" / "bea" / "bea-name-manifest.json"
TAURI_MANIFEST = REPO_ROOT / "src-tauri" / "resources" / "voices" / "bea" / "bea-name-manifest.json"
DIST_MANIFEST = REPO_ROOT / "client" / "dist" / "voices" / "bea" / "bea-name-manifest.json"


def normalize_pronunciation(raw_name: str) -> str:
    """
    Optimizes Filipino/English employee and intern name pronunciations for natural speech synthesis:
    - Expands "Ma." abbreviation to "Maria" (e.g., "Ma. Ellaine" -> "Maria Ellaine")
    - Cleans up middle initials (e.g., "Deign Grey O. Lazaro" -> "Deign Grey Lazaro" for smoother natural cadence)
    - Removes hyphen noise from "Ar-jee" -> "Arjee"
    """
    clean = raw_name.strip()
    if clean.startswith("Admin Rfid"):
        return clean
    
    # Expand "Ma." / "Ma " prefix to "Maria "
    if clean.startswith("Ma. ") or clean.startswith("Ma "):
        clean = "Maria " + clean[4:]
    
    # Clean middle initials like " O. ", " P. ", " C. " -> remove initial for seamless spoken flow
    parts = clean.split()
    speech_parts = []
    for p in parts:
        if len(p) == 2 and p[1] == '.' and p[0].isalpha():
            # Skip middle initial for cleaner speech, or keep initial letter
            continue
        speech_parts.append(p)
    
    spoken = " ".join(speech_parts)
    # Clean hyphens in first names like "Ar-jee" -> "Arjee"
    spoken = spoken.replace("Ar-jee", "Arjee")
    return spoken


def get_voicebox_bea_profile():
    try:
        req = urllib.request.urlopen(f"{VOICEBOX_BASE}/profiles")
        profiles = json.loads(req.read().decode())
        for p in profiles:
            if "bea" in p["name"].lower():
                return p["id"]
    except Exception as e:
        print(f"Error connecting to Voicebox: {e}")
    return None


def generate_name_audio(profile_id: str, text: str, out_path: Path) -> bool:
    payload = json.dumps({
        "profile_id": profile_id,
        "text": text,
        "engine": "qwen",
        "model_size": "1.7B"
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
        print(f"  Failed to start generation: {e}")
        return False

    for _ in range(60):
        time.sleep(2)
        try:
            req = urllib.request.urlopen(f"{VOICEBOX_BASE}/history/{gen_id}")
            hist = json.loads(req.read().decode())
            status = hist.get("status")
            if status == "completed":
                audio_url = f"{VOICEBOX_BASE}/audio/{gen_id}"
                urllib.request.urlretrieve(audio_url, out_path)
                return out_path.is_file() and out_path.stat().st_size > 100
            elif status == "failed":
                print(f"  Generation failed for '{text}': {hist.get('error')}")
                return False
        except Exception:
            pass

    return False


def main():
    print("=" * 80)
    print(" GENERATING VOICEBOX CLONED NAMES FOR BACKUP USERS & INTERNS")
    print(" Source: attendance-backup-20260831-050918.apbackup")
    print(" Engine: Voicebox Qwen-TTS 1.7B (Ma'am Bea Cloned Voice)")
    print("=" * 80)

    profile_id = get_voicebox_bea_profile()
    if not profile_id:
        print("Voicebox not running or Ma'am Bea profile not found.", flush=True)
        return

    print(f"Active Voicebox Profile ID: {profile_id}")

    CLIENT_NAMES_DIR.mkdir(parents=True, exist_ok=True)
    TAURI_NAMES_DIR.mkdir(parents=True, exist_ok=True)
    DIST_NAMES_DIR.mkdir(parents=True, exist_ok=True)

    # Read users from backup SQLite database
    with zipfile.ZipFile(BACKUP_PATH, 'r') as z:
        with tempfile.NamedTemporaryFile(suffix='.db', delete=False) as tmp:
            tmp.write(z.read('database/attendance.db'))
            tmp_path = tmp.name

    try:
        conn = sqlite3.connect(tmp_path)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute("SELECT * FROM users WHERE status = 'ACTIVE' ORDER BY employee_type, full_name;")
        users = [dict(r) for r in cur.fetchall()]
        conn.close()
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass

    print(f"Discovered {len(users)} active employees and interns from backup database.")

    manifest = {
        "version": "1.0.0",
        "voice": "bea",
        "engine": "voicebox-qwen-1.7B-cuda-cloned",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "profiles": {}
    }

    generated_count = 0

    for idx, u in enumerate(users, start=1):
        user_id = u["user_id"]
        raw_name = u["full_name"]
        emp_type = u["employee_type"]

        # Skip admin card
        if user_id.startswith("ADMIN_CARD"):
            continue

        spoken_name = normalize_pronunciation(raw_name)
        out_client = CLIENT_NAMES_DIR / f"{user_id}.wav"
        out_tauri = TAURI_NAMES_DIR / f"{user_id}.wav"
        out_dist = DIST_NAMES_DIR / f"{user_id}.wav"

        print(f"\n[{idx}/{len(users)}] [{emp_type}] ID: {user_id}")
        print(f"  Display Name: \"{raw_name}\"")
        print(f"  Spoken Name:  \"{spoken_name}\"")

        if not (out_client.is_file() and out_client.stat().st_size > 1000):
            print(f"  -> Generating via Voicebox Qwen-TTS 1.7B...")
            success = generate_name_audio(profile_id, spoken_name, out_client)
            if success and out_client.is_file():
                print(f"  ✓ Successfully generated ({out_client.stat().st_size} bytes)")
            else:
                print(f"  ✗ Failed to generate name audio for {raw_name}")
                continue
        else:
            print(f"  ✓ Already cached ({out_client.stat().st_size} bytes)")

        # Copy to Tauri resources and Dist
        if out_client.is_file():
            import shutil
            shutil.copy2(out_client, out_tauri)
            shutil.copy2(out_client, out_dist)

            with open(out_client, "rb") as f:
                audio_hash = hashlib.sha256(f.read()).hexdigest()

            rel_url = f"/voices/bea/names/{user_id}.wav"
            manifest["profiles"][user_id] = {
                "personId": user_id,
                "displayName": raw_name,
                "normalizedSpeechText": spoken_name,
                "employeeType": emp_type,
                "voiceProfileVersion": "1.7B-qwen-cloned-v1",
                "audioFile": rel_url,
                "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "audioHash": audio_hash
            }
            generated_count += 1

    # Save manifests
    for manifest_path in [CLIENT_MANIFEST, TAURI_MANIFEST, DIST_MANIFEST]:
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2)

    print("\n" + "=" * 80)
    print(f" All Done: {generated_count} active employee and intern names generated.")
    print(f" Client Manifest: {CLIENT_MANIFEST}")
    print(f" Tauri Manifest:  {TAURI_MANIFEST}")
    print("=" * 80)


if __name__ == "__main__":
    main()
