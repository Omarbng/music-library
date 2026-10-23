"""Use the Telegram "Music Library" channel (made by telegram_upload.py) as the website's library.

Settings in .env:
  STORAGE=telegram
  TG_API_ID, TG_API_HASH     same keys as the uploader
  TG_CHANNEL_TITLE           channel name to look for (default: Music Library)

The website signs in with its own session (.cache/telegram_site.session), separate from the
uploader's, because one Telegram session must not be used by two programs at the same time.
"""

from __future__ import annotations

import asyncio
import io
import json
import re
import time
from pathlib import Path

from PIL import Image

REQUEST_SIZE = 512 * 1024          # Telegram serves files in aligned 512 KB requests
LOSSLESS = ("FLAC", "ALAC", "WAV", "AIFF")
INDEX_VERSION = 1


def _split_edition(text: str) -> tuple[str, str]:
    """'Beginnings [2026 Beginnings]' -> ('Beginnings', '2026 Beginnings')."""
    m = re.match(r"^(.*?)\s*\[(.+)\]\s*$", text)
    return (m.group(1).strip(), m.group(2).strip()) if m else (text.strip(), "")


def parse_album_post(text: str) -> dict | None:
    """Album header posted by the uploader: '💿 Title [edition]\\n👤 Artist\\n2026 · 5 tracks · MP3 · 128 kbps'."""
    lines = [l.strip() for l in (text or "").splitlines()]
    if not lines or not lines[0].startswith("💿"):
        return None
    title, edition = _split_edition(lines[0].lstrip("💿").strip())
    artist = lines[1].lstrip("👤").strip() if len(lines) > 1 and lines[1].startswith("👤") else ""
    year = ""
    if len(lines) > 2:
        m = re.match(r"^((?:19|20)\d\d)\b", lines[2])
        year = m.group(1) if m else ""
    return {"title": title, "edition": edition, "artist": artist, "year": year}


def parse_track(msg) -> dict | None:
    """An audio message: title/artist/duration from its audio attributes, album from the caption."""
    from telethon.tl.types import DocumentAttributeAudio, DocumentAttributeFilename

    doc = getattr(msg, "document", None)
    if doc is None:
        return None
    audio = next((a for a in doc.attributes if isinstance(a, DocumentAttributeAudio)), None)
    if audio is None or getattr(audio, "voice", False):
        return None
    fname = next((a.file_name for a in doc.attributes if isinstance(a, DocumentAttributeFilename)), "")
    lines = [l.strip() for l in (msg.message or "").splitlines()]

    title = audio.title or (Path(fname).stem if fname else f"Track {msg.id}")
    artist = audio.performer or ""
    if lines and " — " in lines[0]:
        cap_artist, cap_title = lines[0].split(" — ", 1)
        artist = artist or cap_artist.strip()
        title = audio.title or cap_title.strip()
    artist = artist or "Unknown Artist"

    album, edition, quality = "", "", ""
    if len(lines) > 1 and not lines[1].startswith("#"):
        album_part, _, quality = lines[1].rpartition(" · ") if " · " in lines[1] else (lines[1], "", "")
        # quality itself contains " · " (e.g. "FLAC · 24-bit · 44.1 kHz"): split at the first codec word.
        m = re.match(r"^(.*?) · ((?:MP3|FLAC|ALAC|AAC|WAV|AIFF|OGG|OPUS)\b.*)$", lines[1])
        if m:
            album_part, quality = m.group(1), m.group(2)
        album, edition = _split_edition(album_part)
    if not album:
        album = "Telegram uploads"

    ext = Path(fname).suffix.lower().lstrip(".") if fname else (doc.mime_type or "audio/mpeg").split("/")[-1]
    if not quality:
        quality = {"mpeg": "MP3", "mp3": "MP3", "flac": "FLAC", "x-flac": "FLAC", "mp4": "AAC", "m4a": "AAC",
                   "wav": "WAV", "x-wav": "WAV", "ogg": "OGG"}.get(ext, ext.upper() or "Audio")
    codec = quality.split(" · ")[0]
    return {
        "msg_id": msg.id, "title": title, "artist": artist, "album": album, "edition": edition,
        "quality": quality, "codec": codec, "lossless": codec in LOSSLESS,
        "duration": float(audio.duration or 0), "size": int(doc.size or 0),
        "file_name": fname or f"{artist} - {title}.{ext or 'mp3'}",
        "mime": doc.mime_type or "audio/mpeg", "date": msg.date.timestamp() if msg.date else 0.0,
    }


class TelegramStore:
    def __init__(self, env: dict, cache_dir: Path):
        self.env = env
        self.cache_dir = cache_dir
        self.session = cache_dir / "telegram_site"
        self.index_file = cache_dir / "telegram_index.json"
        self.uploader_state = cache_dir / "telegram_state.json"
        self.client = None
        self.channel = None
        self._media: dict[int, tuple[float, object]] = {}

    def _new_client(self):
        from telethon import TelegramClient
        api_id, api_hash = self.env.get("TG_API_ID"), self.env.get("TG_API_HASH")
        if not api_id or not api_hash:
            raise SystemExit("STORAGE=telegram needs TG_API_ID and TG_API_HASH in .env "
                             "(run telegram_upload.py once, or add them by hand).")
        session_string = self.env.get("TG_SESSION")
        if session_string:
            from telethon.sessions import StringSession
            session = StringSession(session_string)   # cloud: login comes from a secret
        else:
            session = str(self.session)               # PC: login file in .cache
        client = TelegramClient(session, int(api_id), api_hash,
                                device_model="Music website", app_version="1.0")
        client.flood_sleep_threshold = 120
        return client

    # ----- sign-in (run once in the console, before the web server starts) -----
    def ensure_login(self) -> None:
        async def run():
            client = self._new_client()
            await client.connect()
            if not await client.is_user_authorized():
                if self.env.get("TG_SESSION"):
                    raise SystemExit("TG_SESSION is not a valid, signed-in Telegram session. "
                                     "Create a new one with make_cloud_login.py.")
                print("\nThe website needs to sign in to Telegram once (separately from the uploader).")
                await client.start()
            me = await client.get_me()
            print(f"Telegram: signed in as {me.first_name}.")
            await client.disconnect()
        asyncio.run(run())

    # ----- runtime (inside the web server's event loop) -----
    async def connect(self) -> None:
        self.client = self._new_client()
        await self.client.connect()
        if not await self.client.is_user_authorized():
            raise RuntimeError("Telegram session is not signed in. Restart the site from a console window.")
        self.channel = await self._find_channel()

    async def disconnect(self) -> None:
        if self.client is not None:
            await self.client.disconnect()

    async def _find_channel(self):
        from telethon.tl.types import PeerChannel
        if self.uploader_state.exists():
            try:
                cid = json.loads(self.uploader_state.read_text()).get("channel_id")
                if cid:
                    return await self.client.get_entity(PeerChannel(cid))
            except Exception:
                pass
        title = self.env.get("TG_CHANNEL_TITLE", "Music Library")
        async for dialog in self.client.iter_dialogs():
            if dialog.is_channel and dialog.name == title:
                return dialog.entity
        raise RuntimeError(f"No Telegram channel named “{title}” on this account. Set TG_CHANNEL_TITLE in .env.")

    async def build_index(self, full: bool = False) -> dict:
        """Read the channel (only new messages unless full=True) and return data for Library.load_index."""
        cached = {}
        if not full and self.index_file.exists():
            try:
                cached = json.loads(self.index_file.read_text())
                if cached.get("version") != INDEX_VERSION or cached.get("channel_id") != self.channel.id:
                    cached = {}
            except Exception:
                cached = {}
        tracks = cached.get("tracks", [])
        posts = cached.get("posts", [])
        last_id = cached.get("last_id", 0)
        async for msg in self.client.iter_messages(self.channel, min_id=last_id, reverse=True):
            last_id = max(last_id, msg.id)
            post = parse_album_post(msg.message) if not getattr(msg, "document", None) else None
            if post:
                post["msg_id"] = msg.id
                post["has_photo"] = bool(getattr(msg, "photo", None))
                posts.append(post)
                continue
            track = parse_track(msg)
            if track:
                tracks.append(track)
        data = {"version": INDEX_VERSION, "channel_id": self.channel.id, "last_id": last_id,
                "tracks": tracks, "posts": posts, "updated": time.time()}
        self.index_file.write_text(json.dumps(data))
        return self.to_library_index(data)

    @staticmethod
    def to_library_index(data: dict) -> dict:
        """Shape the channel index like library.json so Library.load_index can group it into albums."""
        root = "/telegram"
        years = {(p["artist"].lower(), p["title"].lower(), p["edition"].lower()): p.get("year", "")
                 for p in data["posts"]}
        out, covers, counters = [], {}, {}
        for t in sorted(data["tracks"], key=lambda t: t["msg_id"]):
            folder = f"{root}/{t['artist']}/{t['edition'] or t['album']}"
            counters[folder] = counters.get(folder, 0) + 1
            out.append({
                "id": f"tg{t['msg_id']}", "path": f"{folder}/{t['file_name']}", "title": t["title"],
                "artist": t["artist"], "album_artist": t["artist"], "album": t["album"],
                "track_no": counters[folder], "disc_no": 0,
                "year": years.get((t["artist"].lower(), t["album"].lower(), t["edition"].lower()), ""),
                "genre": "", "duration": t["duration"], "codec": t["codec"], "quality": t["quality"],
                "lossless": t["lossless"], "size": t["size"], "mtime": t["date"], "album_id": "",
                "key": f"tg:{t['msg_id']}",
            })
        for p in data["posts"]:
            if p.get("has_photo"):
                covers[f"{root}/{p['artist']}/{p['edition'] or p['title']}"] = p["msg_id"]
        return {"root": root, "updated": data.get("updated", 0), "tracks": out, "covers": covers}

    # ----- media -----
    async def _message_media(self, msg_id: int):
        cached = self._media.get(msg_id)
        if cached and time.time() - cached[0] < 1800:
            return cached[1]
        msg = await self.client.get_messages(self.channel, ids=msg_id)
        if msg is None or msg.media is None:
            raise FileNotFoundError(msg_id)
        self._media[msg_id] = (time.time(), msg)
        return msg

    async def iter_bytes(self, msg_id: int, start: int = 0, end: int | None = None, size: int | None = None):
        """Yield the bytes start..end (inclusive) of a message's file."""
        msg = await self._message_media(msg_id)
        size = size or msg.file.size
        end = size - 1 if end is None else min(end, size - 1)
        aligned = start - (start % REQUEST_SIZE)
        skip, remaining = start - aligned, end - start + 1
        stream = self.client.iter_download(msg.media, offset=aligned, request_size=REQUEST_SIZE, file_size=size)
        try:
            async for chunk in stream:
                if skip:
                    chunk, skip = chunk[skip:], 0
                if len(chunk) > remaining:
                    chunk = chunk[:remaining]
                if chunk:
                    yield chunk
                    remaining -= len(chunk)
                if remaining <= 0:
                    break
        finally:
            await stream.close()

    async def cover_bytes(self, msg_id: int, size: int) -> bytes | None:
        msg = await self._message_media(msg_id)
        if not getattr(msg, "photo", None):
            return None
        data = await self.client.download_media(msg, bytes)
        if not data:
            return None
        img = Image.open(io.BytesIO(data)).convert("RGB")
        img.thumbnail((size, size), Image.LANCZOS)
        out = io.BytesIO()
        img.save(out, "JPEG", quality=86)
        return out.getvalue()
