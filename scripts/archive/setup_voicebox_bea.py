import urllib.request
import json
import mimetypes
import uuid
from pathlib import Path

VOICEBOX_BASE = "http://127.0.0.1:17493"
REF_DIR = Path("C:/Users/Deign/Downloads/Music")

def post_multipart(url, fields, files):
    boundary = f"----WebKitFormBoundary{uuid.uuid4().hex}"
    body = bytearray()

    for k, v in fields.items():
        body.extend(f"--{boundary}\r\n".encode())
        body.extend(f'Content-Disposition: form-data; name="{k}"\r\n\r\n'.encode())
        body.extend(f"{v}\r\n".encode())

    for k, filepath in files.items():
        p = Path(filepath)
        filename = p.name
        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        body.extend(f"--{boundary}\r\n".encode())
        body.extend(f'Content-Disposition: form-data; name="{k}"; filename="{filename}"\r\n'.encode())
        body.extend(f"Content-Type: {content_type}\r\n\r\n".encode())
        with open(p, "rb") as f:
            body.extend(f.read())
        body.extend(b"\r\n")

    body.extend(f"--{boundary}--\r\n".encode())

    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST"
    )
    with urllib.request.urlopen(req) as res:
        return json.loads(res.read().decode())

def get_or_create_bea_profile():
    req = urllib.request.urlopen(f"{VOICEBOX_BASE}/profiles")
    profiles = json.loads(req.read().decode())
    for p in profiles:
        if "bea" in p["name"].lower():
            print(f"Using profile: {p['id']} - {p['name']}")
            return p["id"]

    data = json.dumps({"name": "Ma'am Bea"}).encode()
    req = urllib.request.Request(
        f"{VOICEBOX_BASE}/profiles",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    with urllib.request.urlopen(req) as res:
        prof = json.loads(res.read().decode())
        print(f"Created profile: {prof['id']} - {prof['name']}")
        return prof["id"]

def upload_samples(profile_id):
    samples = [
        (
            REF_DIR / "Main Reference.wav",
            "Good morning. Please tap your ID card to record your time in. Your attendance has been logged successfully. If you need assistance, please wait for a staff member. Thank you and have a great day."
        ),
        (
            REF_DIR / "Neutral.wav",
            "Sorry, that card wasn't recognized. Please try scanning again."
        ),
        (
            REF_DIR / "Warm.wav",
            "Your bathroom key has been checked out. Please return it within 15 minutes."
        ),
    ]
    for filepath, ref_text in samples:
        if filepath.is_file():
            print(f"Uploading sample {filepath.name} with reference text...")
            try:
                res = post_multipart(
                    f"{VOICEBOX_BASE}/profiles/{profile_id}/samples",
                    {"reference_text": ref_text},
                    {"file": filepath}
                )
                print(f"Uploaded {filepath.name}: {res.get('id', 'OK')}")
            except Exception as e:
                print(f"Error uploading {filepath.name}: {e}")

if __name__ == "__main__":
    pid = get_or_create_bea_profile()
    upload_samples(pid)
