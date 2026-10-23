"""Deploy the music website to Hugging Face (free) and keep it updated.

What it does
  1. Uploads your music (MUSIC_DIR) to a PRIVATE dataset:  <you>/music-library-files
     Only real, playable audio and album cover images are sent; it mirrors the folder,
     so files you remove locally are removed there too.
  2. Uploads the website code to a PUBLIC Space:            <you>/music-library
     The site itself stays password-protected; the music files are never public.
  3. Sets the Space's secrets (PASSWORD, SECRET_KEY, HF_TOKEN) and settings (HF_DATASET).

Before the first run, sign this computer in to Hugging Face once (in the Terminal app):
    uvx --from huggingface_hub hf auth login
(create a token with "Write" access at https://huggingface.co/settings/tokens and paste it there)

Usage
    uv run deploy_hf.py --dry-run     # show what would be uploaded
    uv run deploy_hf.py               # deploy / update
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import hmac
import json
import secrets
import sys
from pathlib import Path

from huggingface_hub import CommitOperationAdd, CommitOperationDelete, HfApi, get_token

from library import Library
from storage_r2 import load_env

HERE = Path(__file__).resolve().parent
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
SPACE_FILES = ["Dockerfile", "README.md", "requirements.txt", "app.py", "library.py",
               "storage_r2.py", "storage_telegram.py"]


def fmt(n: int) -> str:
    return f"{n / 1e9:.2f} GB" if n >= 1e9 else f"{n / 1e6:.1f} MB"


def music_files(env: dict) -> tuple[Path, dict[str, Path]]:
    """Real audio files the library accepts, plus cover images in album folders."""
    lib = Library(Path(env.get("MUSIC_DIR", Path.home() / "Music")), env.get("EXCLUDE", "rekordbox").split(","),
                  HERE / ".cache", online_art=False)
    lib.scan()
    files: dict[str, Path] = {}
    for t in lib.tracks.values():
        p = Path(t.path)
        files[p.relative_to(lib.root).as_posix()] = p
        if p.parent != lib.root:
            for img in p.parent.iterdir():
                if img.suffix.lower() in IMAGE_EXTS and not img.name.startswith("."):
                    files[img.relative_to(lib.root).as_posix()] = img
    return lib.root, files


PASSWORD_FILE = ".site/password.json"


def password_op(api: HfApi, dataset: str, password: str):
    """Keep the online site's password the same as this computer's: store a salted hash of it next to the music.
    Returns an upload, or None when the hash already up there matches."""
    if not password:
        return None
    try:
        old = json.loads(Path(api.hf_hub_download(dataset, PASSWORD_FILE, repo_type="dataset", force_download=True)).read_text())
        got = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(old["salt"]), int(old["rounds"]))
        if hmac.compare_digest(got.hex(), old["hash"]):
            return None
    except Exception:
        pass  # not uploaded yet, or unreadable: write a fresh one
    salt, rounds = secrets.token_bytes(16), 310_000
    data = {"salt": salt.hex(), "rounds": rounds,
            "hash": hashlib.pbkdf2_hmac("sha256", password.encode(), salt, rounds).hex()}
    print("Password changed on this computer: the online site will use it after its next restart.")
    return CommitOperationAdd(path_in_repo=PASSWORD_FILE, path_or_fileobj=json.dumps(data).encode())


def main():
    ap = argparse.ArgumentParser(description="Deploy the music website to Hugging Face.")
    ap.add_argument("--dry-run", action="store_true", help="only show what would be uploaded")
    ap.add_argument("--space", default="music-library", help="Space name (default: music-library)")
    ap.add_argument("--dataset", default="music-library-files", help="private dataset name")
    ap.add_argument("--music-only", action="store_true",
                    help="only sync the music to the private dataset (use this with Render)")
    ap.add_argument("--reuse-login-token", action="store_true",
                    help="give the Space your login token instead of asking for a read-only one")
    args = ap.parse_args()

    env = load_env()
    root, files = music_files(env)
    total = sum(p.stat().st_size for p in files.values())
    print(f"Music folder: {root}")
    print(f"To mirror: {len(files)} files, {fmt(total)}")
    for rel in sorted(files):
        print(f"   {rel}")

    token = get_token() or env.get("HF_TOKEN", "")
    if not token:
        sys.exit("\nThis computer isn't signed in to Hugging Face yet. In the Terminal app, run:\n"
                 "    uvx --from huggingface_hub hf auth login\n"
                 "paste a token with Write access (https://huggingface.co/settings/tokens), then run this again.")
    api = HfApi(token=token)
    user = api.whoami()["name"]
    dataset, space = f"{user}/{args.dataset}", f"{user}/{args.space}"
    print(f"\nSigned in to Hugging Face as {user}.")
    print(f"Private dataset: https://huggingface.co/datasets/{dataset}")
    print(f"Public Space:    https://huggingface.co/spaces/{space}")
    if args.dry_run:
        print("\nDry run: nothing uploaded.")
        return

    # 1. private music dataset (mirror the folder)
    api.create_repo(dataset, repo_type="dataset", private=True, exist_ok=True)
    info = api.repo_info(dataset, repo_type="dataset")
    if not getattr(info, "private", True):
        sys.exit(f"Refusing to upload: {dataset} exists and is PUBLIC. Make it private on Hugging Face first.")
    remote = {f.rfilename: f.size for f in api.list_repo_tree(dataset, repo_type="dataset", recursive=True)
              if hasattr(f, "size") and f.rfilename != ".gitattributes"}
    ops = [CommitOperationAdd(path_in_repo=rel, path_or_fileobj=str(p)) for rel, p in sorted(files.items())
           if remote.get(rel) != p.stat().st_size]
    ops += [CommitOperationDelete(path_in_repo=rel) for rel in remote if rel not in files and rel != PASSWORD_FILE]
    pw_op = password_op(api, dataset, env.get("PASSWORD", ""))
    if pw_op:
        ops.append(pw_op)
    if ops:
        print(f"\nUploading: {sum(isinstance(o, CommitOperationAdd) for o in ops)} new/changed, "
              f"{sum(isinstance(o, CommitOperationDelete) for o in ops)} removed ...")
        api.create_commit(dataset, repo_type="dataset", operations=ops, commit_message="Sync music library")
    else:
        print("\nMusic dataset already up to date.")

    if args.music_only:
        print("Music synced. On Render, open the music-library service and click Manual Deploy > Restart service "
              "(or just wait: it reloads the music every time it wakes up).")
        return

    # 2. Space secrets & settings (set before the code so the first build starts with them)
    api.create_repo(space, repo_type="space", space_sdk="docker", private=False, exist_ok=True)
    password = env.get("PASSWORD", "")
    if not password:
        password = getpass.getpass("Website password for the online site: ").strip()
    read_token = ""
    if not args.reuse_login_token and sys.stdin.isatty():
        print("\nThe Space needs a token that can READ your private music dataset.")
        print("Best: create a new token with 'Read' access at https://huggingface.co/settings/tokens")
        read_token = getpass.getpass("Paste it here (or press Enter to reuse your login token): ").strip()
    space_token = read_token or token
    api.add_space_secret(space, "PASSWORD", password)
    api.add_space_secret(space, "SECRET_KEY", secrets.token_hex(32))
    api.add_space_secret(space, "HF_TOKEN", space_token)
    api.add_space_variable(space, "HF_DATASET", dataset)
    api.add_space_variable(space, "STORAGE", "local")
    for key in ("SITE_NAME", "SITE_ARTIST", "EXCLUDE"):
        if env.get(key):
            api.add_space_variable(space, key, env[key])

    # 3. website code
    code_ops = [CommitOperationAdd(path_in_repo=name, path_or_fileobj=str(HERE / name)) for name in SPACE_FILES]
    code_ops += [CommitOperationAdd(path_in_repo=f"static/{p.name}", path_or_fileobj=str(p))
                 for p in sorted((HERE / "static").iterdir()) if p.is_file() and not p.name.startswith(".")]
    api.create_commit(space, repo_type="space", operations=code_ops, commit_message="Deploy music website")

    host = f"{user}-{args.space}".lower().replace("_", "-").replace(".", "-")
    print("\nDone. The Space is building now (a few minutes the first time).")
    print(f"Share this link:  https://{host}.hf.space")
    print("Password: the same PASSWORD as your local site." if env.get("PASSWORD") else "Password: the one you just entered.")
    if not read_token:
        print("Note: the Space is using your login token. For extra safety, later replace the HF_TOKEN secret "
              "with a Read-only token in the Space's Settings.")


if __name__ == "__main__":
    main()
