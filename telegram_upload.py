"""Upload your music library to a private Telegram channel.

Each album gets a cover post, then every track is sent as a playable audio file
with title, artist, duration and cover art. Progress is saved after every track,
so you can stop with Ctrl+C and run it again to continue where it left off.

Usage:
  uv run telegram_upload.py --dry-run          # list what would be uploaded
  uv run telegram_upload.py                    # upload everything not yet uploaded
  uv run telegram_upload.py --only "eastmynd"  # only albums/artists matching text

Settings (in .env):
  TG_API_ID, TG_API_HASH   from https://my.telegram.org -> API development tools
  TG_TARGET                "channel" (default: a private channel) or "me" (Saved Messages)
  TG_CHANNEL_TITLE         name of the private channel (default: Music Library)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time
from pathlib import Path

from library import Library

HERE = Path(__file__).resolve().parent
ENV_FILE = Path(os.environ.get("MUSIC_SITE_ENV") or HERE / ".env")
CACHE = HERE / ".cache"
STATE_FILE = CACHE / "telegram_state.json"
SESSION = CACHE / "telegram"  # Telethon adds .session
MAX_BYTES = 2_097_152_000     # Telegram's 2 GB file limit for regular accounts


def load_env() -> dict:
    env = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = (lambda _v: _v[1:-1] if len(_v) >= 2 and _v[0] == _v[-1] and _v[0] in "\"'" else _v)(v.strip())
    return env


def load_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {"channel_id": None, "albums": {}, "tracks": {}}


def save_state(state: dict) -> None:
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=1))
    tmp.replace(STATE_FILE)


def track_key(t) -> str:
    return f"{t.path}|{t.size}|{int(t.mtime)}"


def hashtag(text: str) -> str:
    tag = re.sub(r"[^\w]+", "_", text, flags=re.UNICODE).strip("_")
    if not tag:
        return ""
    if tag[0].isdigit():
        tag = "_" + tag
    return "#" + tag[:60]


def fmt_size(n: int) -> str:
    return f"{n / 1e9:.2f} GB" if n >= 1e9 else f"{n / 1e6:.1f} MB"


def plan(lib: Library, state: dict, only: str | None):
    """Albums (sorted) with the tracks that still need uploading."""
    needle = (only or "").lower()
    todo = []
    for album in sorted(lib.albums.values(), key=lambda a: (a.artist.lower(), a.title.lower(), a.edition)):
        if needle and needle not in f"{album.artist} {album.title} {album.edition}".lower():
            continue
        tracks = [lib.tracks[i] for i in album.track_ids]
        pending = [t for t in tracks if track_key(t) not in state["tracks"]]
        if pending:
            todo.append((album, pending))
    return todo


class Progress:
    def __init__(self, label: str):
        self.label = label
        self.start = time.time()
        self.last = 0.0

    def __call__(self, sent: int, total: int):
        now = time.time()
        if now - self.last < 0.5 and sent < total:
            return
        self.last = now
        speed = sent / max(now - self.start, 0.001)
        pct = 100 * sent / total if total else 100
        sys.stdout.write(f"\r    {self.label[:48]:48} {pct:5.1f}%  {fmt_size(sent):>9} of {fmt_size(total):<9} "
                         f"{speed / 1e6:5.1f} MB/s ")
        sys.stdout.flush()


def ask_for_keys() -> tuple[str, str]:
    """Ask for the Telegram API keys once and save them to .env."""
    help_text = ("Telegram API keys are needed once.\n"
                 "1. Open https://my.telegram.org and sign in with your phone number.\n"
                 "2. Click 'API development tools' and create an app (any name, e.g. Music uploader).\n"
                 "3. Copy the 'App api_id' and 'App api_hash' it shows.\n")
    if not sys.stdin.isatty():
        raise SystemExit(help_text + f"Then run it in a terminal window (Terminal on Mac, or the 2-upload-to-telegram.bat file on Windows), or add TG_API_ID and "
                         f"TG_API_HASH to {ENV_FILE}.")
    import getpass
    from setup_r2 import set_values
    print(help_text)
    while True:
        api_id = input("App api_id (a number): ").strip()
        if api_id.isdigit():
            break
        print("  The api_id is a number, like 1234567.")
    while True:
        api_hash = getpass.getpass("App api_hash (hidden as you type): ").strip()
        if re.fullmatch(r"[0-9a-fA-F]{32}", api_hash):
            break
        print("  The api_hash is 32 letters and numbers. Paste it again.")
    set_values({"TG_API_ID": api_id, "TG_API_HASH": api_hash})
    print(f"Saved to {ENV_FILE}.\n")
    return api_id, api_hash


async def get_target(client, env: dict, state: dict):
    from telethon.tl.functions.channels import CreateChannelRequest
    from telethon.tl.types import PeerChannel

    if env.get("TG_TARGET", "channel").lower() == "me":
        return "me"
    if state.get("channel_id"):
        try:
            return await client.get_entity(PeerChannel(state["channel_id"]))
        except Exception:
            print("Saved channel not found; creating a new one.")
    title = env.get("TG_CHANNEL_TITLE", "Music Library")
    result = await client(CreateChannelRequest(title=title, about="My music library, uploaded from my Mac.",
                                               broadcast=True))
    channel = result.chats[0]
    state["channel_id"] = channel.id
    save_state(state)
    print(f"Created private channel “{title}”.")
    return channel


async def upload(args, env: dict, lib: Library, state: dict, todo):
    from telethon import TelegramClient
    from telethon.tl.types import DocumentAttributeAudio

    api_id, api_hash = env.get("TG_API_ID"), env.get("TG_API_HASH")
    if not api_id or not api_hash:
        api_id, api_hash = ask_for_keys()
        env["TG_API_ID"], env["TG_API_HASH"] = api_id, api_hash

    client = TelegramClient(str(SESSION), int(api_id), api_hash,
                            device_model="Music uploader (Mac)", app_version="1.0")
    client.flood_sleep_threshold = 3600  # wait out Telegram's rate limits automatically
    await client.start()  # asks for phone number and login code the first time
    try:
        os.chmod(f"{SESSION}.session", 0o600)
    except OSError:
        pass
    me = await client.get_me()
    print(f"Signed in to Telegram as {me.first_name}.")
    target = await get_target(client, env, state)

    done_tracks = done_bytes = 0
    for album, pending in todo:
        cover = lib.cover(album.id, 800)
        thumb = lib.cover(album.id, 300)
        tags = " ".join(t for t in (hashtag(album.artist), hashtag(album.title)) if t)
        edition = f" [{album.edition}]" if album.edition else ""
        print(f"\n{album.artist} — {album.title}{edition}  ({len(pending)} to upload)")

        if album.id not in state["albums"]:
            info = " · ".join(x for x in (album.year, f"{len(album.track_ids)} tracks", album.quality) if x)
            caption = f"💿 {album.title}{edition}\n👤 {album.artist}\n{info}\n{tags}"
            if cover:
                msg = await client.send_file(target, str(cover), caption=caption)
            else:
                msg = await client.send_message(target, caption)
            state["albums"][album.id] = msg.id
            save_state(state)

        for t in pending:
            path = Path(t.path)
            if not path.is_file():
                print(f"    skipped (file missing): {path.name}")
                continue
            if t.size > MAX_BYTES:
                print(f"    skipped (over Telegram's 2 GB limit): {path.name}")
                continue
            caption = f"{t.artist} — {t.title}\n{album.title}{edition} · {t.quality}\n{tags}"
            attrs = [DocumentAttributeAudio(duration=int(t.duration), title=t.title, performer=t.artist)]
            msg = await client.send_file(
                target, str(path), caption=caption, attributes=attrs,
                thumb=str(thumb) if thumb else None, supports_streaming=True,
                reply_to=state["albums"].get(album.id) if args.threaded else None,
                progress_callback=Progress(path.name),
            )
            state["tracks"][track_key(t)] = {"msg": msg.id, "album": album.id}
            save_state(state)
            done_tracks += 1
            done_bytes += t.size
            sys.stdout.write("\r    ✓ " + path.name[:70].ljust(90) + "\n")

    print(f"\nDone: uploaded {done_tracks} tracks ({fmt_size(done_bytes)}).")
    await client.disconnect()


def main():
    parser = argparse.ArgumentParser(description="Upload your music library to Telegram.")
    parser.add_argument("--dry-run", action="store_true", help="only list what would be uploaded")
    parser.add_argument("--only", help="only albums whose artist, title or folder contains this text")
    parser.add_argument("--threaded", action="store_true", help="post tracks as replies to the album post")
    args = parser.parse_args()

    env = load_env()
    CACHE.mkdir(exist_ok=True)
    lib = Library(Path(env.get("MUSIC_DIR", Path.home() / "Music")), env.get("EXCLUDE", "rekordbox").split(","), CACHE)
    result = lib.scan()
    state = load_state()
    todo = plan(lib, state, args.only)

    total_tracks = sum(len(p) for _, p in todo)
    total_bytes = sum(t.size for _, p in todo for t in p)
    too_big = [t for _, p in todo for t in p if t.size > MAX_BYTES]
    print(f"Library: {result['albums']} albums, {result['tracks']} tracks. "
          f"To upload: {len(todo)} albums, {total_tracks} tracks, {fmt_size(total_bytes)}.")
    if too_big:
        print(f"{len(too_big)} file(s) are over Telegram's 2 GB limit and will be skipped.")

    if args.dry_run or not todo:
        for album, pending in todo:
            edition = f" [{album.edition}]" if album.edition else ""
            print(f"  {album.artist} — {album.title}{edition}: {len(pending)} tracks, "
                  f"{fmt_size(sum(t.size for t in pending))}")
        if not todo:
            print("Everything is already uploaded.")
        return

    try:
        asyncio.run(upload(args, env, lib, state, todo))
    except KeyboardInterrupt:
        print("\nStopped. Progress is saved; run the script again to continue.")


if __name__ == "__main__":
    main()
