"""Watch the music folder and publish new music to void crate automatically.

Every 30 seconds it looks at MUSIC_DIR. When files are added, changed or removed (and have
stopped changing, so half-finished downloads are never sent), it:
  1. syncs the music to the private Hugging Face dataset   (deploy_hf.py --music-only)
  2. asks the live site and the local site to refresh       (sign in + POST /api/rescan)
  3. shows a macOS notification

Usage:
  uv run auto_sync.py            # keep watching (this is what the background service runs)
  uv run auto_sync.py --once     # check and sync right now, then exit

Install as a background service that starts with your Mac:  uv run auto_sync.py --install
Remove it:                                                    uv run auto_sync.py --uninstall
Log file: ~/Library/Logs/void-crate-sync.log
"""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from storage_r2 import load_env  # noqa: E402

STATE = HERE / ".cache" / "autosync_state.json"
LOG = Path.home() / "Library" / "Logs" / "void-crate-sync.log"
PLIST = Path.home() / "Library" / "LaunchAgents" / "space.voidcrate.autosync.plist"
LABEL = "space.voidcrate.autosync"
WATCH_EXTS = {".mp3", ".flac", ".m4a", ".mp4", ".aac", ".wav", ".aif", ".aiff", ".ogg", ".opus",
              ".jpg", ".jpeg", ".png", ".webp"}
PARTIAL_EXTS = {".part", ".crdownload", ".download", ".tmp", ".partial"}
DEFAULT_SITE = "https://music-library-y41v.onrender.com"
POLL = 30


def log(msg: str) -> None:
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)


def notify(text: str) -> None:
    script = f'display notification {json.dumps(text)} with title "void crate"'
    subprocess.run(["osascript", "-e", script], capture_output=True)


def snapshot(root: Path) -> tuple[dict, bool]:
    """{relative path: [size, mtime]} for music and cover files, plus whether a download is still in progress."""
    files, busy = {}, False
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for name in filenames:
            if name.startswith("."):
                continue
            ext = Path(name).suffix.lower()
            if ext in PARTIAL_EXTS:
                busy = True
                continue
            if ext in WATCH_EXTS:
                p = Path(dirpath) / name
                try:
                    st = p.stat()
                except OSError:
                    continue
                files[str(p.relative_to(root))] = [st.st_size, int(st.st_mtime)]
    return files, busy


def load_state() -> dict:
    try:
        return json.loads(STATE.read_text())
    except (OSError, ValueError):
        return {}


def save_state(files: dict) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps({"files": files, "synced_at": time.time()}))


def sync_dataset() -> tuple[bool, str]:
    uv = Path.home() / ".local" / "bin" / "uv"
    r = subprocess.run([str(uv), "run", "--project", str(HERE), str(HERE / "deploy_hf.py"), "--music-only"],
                       cwd=HERE, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=3600)
    out = (r.stdout or "") + (r.stderr or "")
    summary = next((l.strip() for l in out.splitlines() if l.startswith(("Uploading music", "Music dataset already"))), "")
    if r.returncode != 0:
        tail = "\n".join(out.strip().splitlines()[-6:])
        return False, f"sync failed (exit {r.returncode}):\n{tail}"
    return True, summary or "synced"


def refresh_site(base: str, password: str, timeout: int) -> str:
    """Sign in and press Refresh. The free Render instance may need ~1 minute to wake up."""
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    data = urllib.parse.urlencode({"password": password}).encode()
    opener.open(urllib.request.Request(f"{base}/login", data=data), timeout=timeout)
    req = urllib.request.Request(f"{base}/api/rescan", data=b"", method="POST")
    with opener.open(req, timeout=timeout) as resp:
        body = json.loads(resp.read().decode() or "{}")
    if "tracks" in body:
        return f"{body.get('albums')} records, {body.get('tracks')} tracks"
    return str(body.get("status", body))[:80]


def publish(env: dict, changes: str) -> None:
    log(f"change detected ({changes}); syncing to the private dataset ...")
    ok, summary = sync_dataset()
    log(summary)
    if not ok:
        notify("Sync failed — see ~/Library/Logs/void-crate-sync.log")
        raise RuntimeError(summary)
    password = env.get("PASSWORD", "")
    results = []
    for name, base, wait in (("live", env.get("SITE_URL") or DEFAULT_SITE, 300), ("local", f"http://localhost:{env.get('PORT', '8765')}", 60)):
        try:
            res = refresh_site(base.rstrip("/"), password, wait)
            results.append(f"{name}: {res}")
        except Exception as e:  # local site may simply not be running
            results.append(f"{name}: not refreshed ({type(e).__name__})")
    log(" | ".join(results))
    m = re.search(r"(\d+) new/changed, (\d+) removed", summary)
    added = f"{m.group(1)} new or changed, {m.group(2)} removed" if m else "up to date"
    notify(f"Crate updated: {added}")


def describe(old: dict, new: dict) -> str:
    added = len(set(new) - set(old))
    removed = len(set(old) - set(new))
    changed = sum(1 for k in set(old) & set(new) if old[k] != new[k])
    return f"{added} added, {changed} changed, {removed} removed"


def run(once: bool) -> None:
    env = load_env()
    root = Path(env.get("MUSIC_DIR", Path.home() / "Music"))
    if not root.is_dir():
        sys.exit(f"Music folder not found: {root}")
    log(f"watching {root} (every {POLL}s)")
    synced = load_state().get("files")
    pending = None
    while True:
        try:
            files, busy = snapshot(root)
        except PermissionError:
            log("macOS blocked access to the music folder. Allow it in System Settings > Privacy & Security > "
                "Files and Folders (or Full Disk Access) for 'uv'/'python', or move the music folder out of Downloads.")
            notify("Can't read the music folder — see the log")
            if once:
                return
            time.sleep(300)
            continue
        if synced is None:  # first run: sync once to establish the baseline
            synced = {}
        if files != synced:
            if once or (pending == files and not busy):  # unchanged since last look = finished copying
                try:
                    publish(env, describe(synced, files))
                    synced = files
                    save_state(files)
                except Exception as e:
                    log(f"will retry: {e}")
                pending = None
            else:
                pending = files
                if busy:
                    log("a download is still in progress; waiting")
        elif once:
            log("nothing new")
        if once:
            return
        time.sleep(POLL)


def install() -> None:
    uv = Path.home() / ".local" / "bin" / "uv"
    LOG.parent.mkdir(parents=True, exist_ok=True)
    PLIST.parent.mkdir(parents=True, exist_ok=True)
    PLIST.write_text(f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>{uv}</string><string>run</string><string>--project</string><string>{HERE}</string><string>{HERE / 'auto_sync.py'}</string>
  </array>
  <key>WorkingDirectory</key><string>{HERE}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>{LOG}</string>
  <key>StandardErrorPath</key><string>{LOG}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>{uv.parent}:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
</dict></plist>
""")
    uid = os.getuid()
    subprocess.run(["launchctl", "bootout", f"gui/{uid}/{LABEL}"], capture_output=True)
    r = subprocess.run(["launchctl", "bootstrap", f"gui/{uid}", str(PLIST)], capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"Couldn't start the background service: {r.stderr.strip()}")
    print(f"Installed. void crate now syncs new music automatically.\nLog: {LOG}\nStop it with: uv run auto_sync.py --uninstall")


def uninstall() -> None:
    subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}/{LABEL}"], capture_output=True)
    PLIST.unlink(missing_ok=True)
    print("Removed the background sync. Your music and the site are unchanged.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Publish new music to void crate automatically.")
    ap.add_argument("--once", action="store_true", help="check and sync now, then exit")
    ap.add_argument("--install", action="store_true", help="run in the background, starting with your Mac")
    ap.add_argument("--uninstall", action="store_true", help="remove the background service")
    a = ap.parse_args()
    if a.install:
        install()
    elif a.uninstall:
        uninstall()
    else:
        run(a.once)
