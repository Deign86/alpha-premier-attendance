import zipfile
import sqlite3
import tempfile
import os
import json
import wave
import hashlib
from pathlib import Path

BACKUP_PATH = r"C:\Users\Deign\Downloads\attendance-backup-20260831-050918.apbackup"
REPO_ROOT = Path(r"c:\Users\Deign\Downloads\alpha-premier-attendance")

CLIENT_NAMES_DIR = REPO_ROOT / "client" / "public" / "voices" / "bea" / "names"
TAURI_NAMES_DIR = REPO_ROOT / "src-tauri" / "resources" / "voices" / "bea" / "names"
DIST_NAMES_DIR = REPO_ROOT / "client" / "dist" / "voices" / "bea" / "names"

CLIENT_MANIFEST = REPO_ROOT / "client" / "public" / "voices" / "bea" / "bea-name-manifest.json"
TAURI_MANIFEST = REPO_ROOT / "src-tauri" / "resources" / "voices" / "bea" / "bea-name-manifest.json"

def main():
    with zipfile.ZipFile(BACKUP_PATH, 'r') as z:
        with tempfile.NamedTemporaryFile(suffix='.db', delete=False) as tmp:
            tmp.write(z.read('database/attendance.db'))
            tmp_path = tmp.name

    try:
        conn = sqlite3.connect(tmp_path)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute("SELECT * FROM users WHERE status = 'ACTIVE' AND user_id NOT LIKE 'ADMIN_CARD%' ORDER BY employee_type, full_name;")
        users = [dict(r) for r in cur.fetchall()]
        conn.close()
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass

    with open(CLIENT_MANIFEST, 'r', encoding='utf-8') as f:
        c_manifest = json.load(f)

    with open(TAURI_MANIFEST, 'r', encoding='utf-8') as f:
        t_manifest = json.load(f)

    print("=" * 115)
    print(f" AUDIT: VERIFYING CLONED MA'AM BEA VOICE FILES FOR ALL BACKUP USERS ({len(users)} ACTIVE USERS)")
    print("=" * 115)
    print(f"{'#':<3} | {'Type':<8} | {'User ID':<14} | {'Display Name':<32} | {'Spoken Phonetic':<28} | {'Duration':<8} | {'Status'}")
    print("-" * 115)

    all_passed = True
    for idx, u in enumerate(users, start=1):
        uid = u['user_id']
        name = u['full_name']
        emp_type = u['employee_type']
        wav_name = f"{uid}.wav"
        c_wav = CLIENT_NAMES_DIR / wav_name
        t_wav = TAURI_NAMES_DIR / wav_name
        d_wav = DIST_NAMES_DIR / wav_name
        
        # 1. Existence check across client, tauri, and dist
        exists_all = c_wav.is_file() and t_wav.is_file() and d_wav.is_file()
        
        # 2. WAV check
        duration_str = "N/A"
        if c_wav.is_file():
            try:
                with wave.open(str(c_wav), 'rb') as w:
                    frames = w.getnframes()
                    rate = w.getframerate()
                    dur = frames / float(rate)
                    duration_str = f"{dur:.2f}s"
            except Exception as e:
                duration_str = "ERR"
                exists_all = False
                
        # 3. Manifest check
        in_client = uid in c_manifest.get('profiles', {})
        in_tauri = uid in t_manifest.get('profiles', {})
        
        # 4. Hash check
        hash_ok = False
        spoken_text = "N/A"
        if c_wav.is_file() and in_client:
            with open(c_wav, 'rb') as f:
                actual_hash = hashlib.sha256(f.read()).hexdigest()
            manifest_hash = c_manifest['profiles'][uid].get('audioHash')
            hash_ok = (actual_hash == manifest_hash)
            spoken_text = c_manifest['profiles'][uid].get('normalizedSpeechText', 'N/A')
            
        status = "OK ✓ (Verified)" if (exists_all and in_client and in_tauri and hash_ok) else "FAIL ✗"
        if "FAIL" in status:
            all_passed = False
            
        print(f"{idx:<3} | {emp_type:<8} | {uid:<14} | {name:<32} | {spoken_text:<28} | {duration_str:<8} | {status}")

    print("=" * 115)
    if all_passed:
        print(f" RESULT: ALL {len(users)} ACTIVE EMPLOYEES & INTERNS HAVE 100% VERIFIED MA'AM BEA CLONED AUDIO FILES!")
    else:
        print(" RESULT: SOME USERS FAILED AUDIT")
    print("=" * 115)

if __name__ == "__main__":
    main()
