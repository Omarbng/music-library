"""Scan a music folder into albums and tracks, with a small on-disk cache."""

from __future__ import annotations

import hashlib
import io
import json
import re
import urllib.parse
import urllib.request
import os
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

import mutagen
from mutagen.flac import FLAC
from mutagen.id3 import ID3
from mutagen.mp4 import MP4
from PIL import Image

AUDIO_EXTS = {".mp3", ".flac", ".m4a", ".mp4", ".aac", ".wav", ".aif", ".aiff", ".ogg", ".opus"}  # .mp4 = audio-only mixes
COVER_NAMES = ("cover", "folder", "front", "album", "artwork")
CACHE_VERSION = 5


def _id(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]


def _first(tags, key, default=""):
    try:
        value = tags.get(key)
    except Exception:
        return default
    if not value:
        return default
    value = value[0] if isinstance(value, list) else value
    return str(value).strip() or default


def _num(text: str) -> int:
    """Parse '3', '3/12' or '03' into 3; anything else into 0."""
    try:
        return int(str(text).split("/")[0])
    except (ValueError, TypeError):
        return 0


@dataclass
class Track:
    id: str
    path: str
    title: str
    artist: str
    album_artist: str
    album: str
    track_no: int
    disc_no: int
    year: str
    genre: str
    duration: float
    codec: str
    quality: str
    lossless: bool
    size: int
    mtime: float
    album_id: str = ""
    key: str = ""  # object key when the file lives in R2
    named_from: str = ""  # "tags", "dash" (Artist - Title file name), "by" (Title by uploader) or ""


@dataclass
class Album:
    id: str
    title: str
    artist: str
    year: str
    folder: str
    edition: str = ""
    track_ids: list[str] = field(default_factory=list)
    duration: float = 0.0
    size: int = 0
    added: float = 0.0
    lossless: bool = False
    quality: str = ""
    genre: str = ""


class NotAudio(Exception):
    """The file has an audio extension but no playable audio (e.g. a saved playlist)."""


_JUNK = re.compile(r"\s*[-–|]?\s*(spotubedl\.com|\[?free download\]?|official audio)\s*$", re.I)


def clean_name(text: str) -> str:
    """Strip downloader junk, duplicate counters and stray separators from a title or file name."""
    s = text or ""
    s = re.sub(r"\s*\(\d+\)\s*$", "", s)          # "song (1)"
    for _ in range(3):
        s = _JUNK.sub("", s)
    s = re.sub(r"\s{2,}", " ", s)
    return s.strip(" -_.")


def name_source(stem: str) -> str:
    s = stem.replace("_", " ")
    return "dash" if " - " in s else ("by" if re.search(r"\sby\s", s) else "")


def name_from_file(stem: str) -> tuple[str, str]:
    """'00 - Butch - Lale' -> ('Butch', 'Lale'); 'Last_Pines_-_Sail' -> ('Last Pines', 'Sail')."""
    s = stem
    if "_" in s and s.count(" ") < s.count("_"):
        s = s.replace("__", " ").replace("_", " ")
    s = clean_name(re.sub(r"^\s*\d{1,3}\s*[-.]\s*", "", s))
    if " - " in s:
        artist, title = s.split(" - ", 1)
        return artist.strip(), clean_name(title)
    m = re.match(r"^(.+?)\s+by\s+([^()]+)$", s)        # "Some Mix (Info) by storytellers"
    if m:
        return m.group(2).strip(), clean_name(m.group(1))
    return "", s


def read_track(path: Path, root: Path) -> Track:
    stat = path.stat()
    audio = None
    try:
        audio = mutagen.File(path, easy=True)
    except Exception:
        audio = None
    tags = (audio.tags if audio is not None else None) or {}
    info = getattr(audio, "info", None)
    if audio is None or not (getattr(info, "length", 0) or 0) > 1:
        raise NotAudio(str(path))

    ext = path.suffix.lower()
    codec = {".mp3": "MP3", ".flac": "FLAC", ".m4a": "AAC", ".mp4": "AAC", ".aac": "AAC", ".wav": "WAV",
             ".aif": "AIFF", ".aiff": "AIFF", ".ogg": "OGG", ".opus": "OPUS"}[ext]
    if ext in (".m4a", ".mp4") and info is not None and "alac" in str(getattr(info, "codec", "")).lower():
        codec = "ALAC"
    lossless = codec in {"FLAC", "ALAC", "WAV", "AIFF"}

    rate = getattr(info, "sample_rate", 0) or 0
    bits = getattr(info, "bits_per_sample", 0) or 0
    if lossless:
        parts = [codec]
        if bits:
            parts.append(f"{bits}-bit")
        if rate:
            parts.append(f"{rate / 1000:g} kHz")
        quality = " · ".join(parts)
    else:
        kbps = round((getattr(info, "bitrate", 0) or 0) / 1000)
        if not kbps and getattr(info, "length", 0):
            kbps = round(stat.st_size * 8 / info.length / 1000)   # estimate when the file doesn't say
        quality = f"{codec} · {kbps} kbps" if kbps else codec

    folder = path.parent
    in_root = folder == root
    file_artist, file_title = name_from_file(path.stem)
    title = clean_name(_first(tags, "title", "")) or file_title or path.stem
    artist = _first(tags, "artist", "") or file_artist or "Unknown Artist"
    named_from = "tags" if _first(tags, "artist", "") else (name_source(path.stem) if file_artist else "")
    album_artist = _first(tags, "albumartist", artist)
    album = _first(tags, "album", title if in_root else folder.name)

    return Track(
        id=_id(str(path)),
        path=str(path),
        title=title,
        artist=artist,
        album_artist=album_artist,
        album=album,
        track_no=_num(_first(tags, "tracknumber", "0")),
        disc_no=_num(_first(tags, "discnumber", "0")),
        year=_first(tags, "date", "")[:4],
        genre=_first(tags, "genre", ""),
        duration=float(getattr(info, "length", 0.0) or 0.0),
        codec=codec,
        quality=quality,
        lossless=lossless,
        size=stat.st_size,
        mtime=stat.st_mtime,
        named_from=named_from,
    )


class Library:
    def __init__(self, root: Path, exclude: list[str], cache_dir: Path, online_art: bool = True):
        self.online_art = online_art
        self.skipped: list[str] = []
        self.root = root.expanduser().resolve()
        self.exclude = {e.strip().lower() for e in exclude if e.strip()}
        self.cache_dir = cache_dir
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        (self.cache_dir / "covers").mkdir(exist_ok=True)
        self.tracks: dict[str, Track] = {}
        self.albums: dict[str, Album] = {}
        self.scanned_at = 0.0
        self.scanning = False
        self._lock = threading.Lock()

    # ---------- scanning ----------
    def _audio_files(self):
        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames[:] = [
                d for d in dirnames
                if not d.startswith(".")
                and not d.endswith((".musiclibrary", ".photoslibrary"))
                and d.lower() not in self.exclude
            ]
            for name in filenames:
                if not name.startswith(".") and Path(name).suffix.lower() in AUDIO_EXTS:
                    yield Path(dirpath) / name

    def scan(self) -> dict:
        with self._lock:
            self.scanning = True
            started = time.time()
            cache_file = self.cache_dir / "library.json"
            cached: dict[str, dict] = {}
            if cache_file.exists():
                try:
                    data = json.loads(cache_file.read_text())
                    if data.get("version") == CACHE_VERSION and data.get("root") == str(self.root):
                        cached = {t["path"]: t for t in data["tracks"]}
                except Exception:
                    cached = {}

            tracks: dict[str, Track] = {}
            skipped: list[str] = []
            read = reused = 0
            for path in self._audio_files():
                try:
                    stat = path.stat()
                    old = cached.get(str(path))
                    if old and old["size"] == stat.st_size and old["mtime"] == stat.st_mtime:
                        track = Track(**old)
                        reused += 1
                    else:
                        try:
                            track = read_track(path, self.root)
                        except NotAudio:
                            skipped.append(str(path))
                            continue
                        read += 1
                    tracks[track.id] = track
                except Exception:
                    continue

            self.albums = self._group(tracks)
            self.tracks = tracks
            self.skipped = skipped
            self.scanned_at = time.time()
            cache_file.write_text(json.dumps({
                "version": CACHE_VERSION,
                "root": str(self.root),
                "tracks": [asdict(t) for t in tracks.values()],
            }))
            self.scanning = False
            return {"tracks": len(tracks), "albums": len(self.albums), "read": read, "skipped": len(skipped),
                    "cached": reused, "seconds": round(time.time() - started, 2)}

    def load_index(self, data: dict) -> dict:
        """Load a track list saved by r2_sync.py instead of scanning local files."""
        with self._lock:
            self.root = Path(data["root"])
            tracks = {d["id"]: Track(**d) for d in data["tracks"]}
            self.albums = self._group(tracks)
            self.tracks = tracks
            self.scanned_at = data.get("updated", 0.0)
            return {"tracks": len(tracks), "albums": len(self.albums), "read": 0, "cached": len(tracks),
                    "seconds": 0}

    def _group(self, tracks: dict[str, Track]) -> dict[str, Album]:
        albums: dict[str, Album] = {}
        for t in tracks.values():
            folder = str(Path(t.path).parent)
            loose = Path(folder) == self.root
            key = f"{'' if loose else folder}|{t.album_artist.lower()}|{t.album.lower()}"
            aid = _id(key)
            t.album_id = aid
            album = albums.get(aid)
            if album is None:
                album = albums[aid] = Album(id=aid, title=t.album, artist=t.album_artist,
                                            year=t.year, folder=folder)
            album.track_ids.append(t.id)
            album.duration += t.duration
            album.size += t.size
            album.added = max(album.added, t.mtime)
            album.year = album.year or t.year
            album.genre = album.genre or t.genre

        # Same artist and title in different folders: label each by its folder.
        seen: dict[tuple, list[Album]] = {}
        for a in albums.values():
            seen.setdefault((a.artist.lower(), a.title.lower()), []).append(a)
        for group in seen.values():
            if len(group) > 1:
                for a in group:
                    a.edition = Path(a.folder).name

        for a in albums.values():
            a.track_ids.sort(key=lambda i: (tracks[i].disc_no, tracks[i].track_no, tracks[i].title.lower()))
            members = [tracks[i] for i in a.track_ids]
            a.lossless = all(m.lossless for m in members)
            qualities = sorted({m.quality for m in members})
            a.quality = qualities[0] if len(qualities) == 1 else "Mixed"
        return albums

    # ---------- covers ----------
    def _cover_source(self, album: Album) -> bytes | None:
        for tid in album.track_ids:
            track_path = Path(self.tracks[tid].path)
            for ext in (".jpg", ".jpeg", ".png", ".webp"):
                side = track_path.with_suffix(ext)
                if side.is_file():
                    return side.read_bytes()
        folder = Path(album.folder)
        if folder != self.root:
            images = [p for p in folder.iterdir()
                      if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp") and not p.name.startswith(".")]
            images.sort(key=lambda p: (p.stem.lower() not in COVER_NAMES, p.name.lower()))
            if images:
                return images[0].read_bytes()
        watermarked = any("spotubedl" in Path(self.tracks[t].path).name.lower() for t in album.track_ids)
        if watermarked and self.online_art:
            data = self._online_art(album)
            if data:
                return data
        for tid in album.track_ids:
            data = embedded_art(Path(self.tracks[tid].path))
            if data:
                return data
        if self.online_art and album.track_ids and not watermarked:
            return self._online_art(album)
        return None

    # ----- artwork from public music catalogues (Apple, then Deezer) -----
    def _online_art(self, album: Album) -> bytes | None:
        first = self.tracks[album.track_ids[0]]
        artist = album.artist
        if artist.lower() in ("various artists", "various", "va", "unknown artist"):
            artist = first.artist if first.artist != "Unknown Artist" else ""
        key = f"{artist}|{album.title}|{first.title}".lower()
        cache_file = self.cache_dir / "art_lookup.json"
        try:
            cache = json.loads(cache_file.read_text()) if cache_file.exists() else {}
        except Exception:
            cache = {}
        url = cache.get(key)
        if url is None:
            url = find_artwork(artist, album.title, first.title,
                               artist_photo=first.named_from in ("tags", "dash")) or ""
            cache[key] = url
            cache_file.write_text(json.dumps(cache, indent=1))
        if not url:
            return None
        try:
            return _http(url, binary=True)
        except Exception:
            return None

    def cover(self, album_id: str, size: int) -> Path | None:
        album = self.albums.get(album_id)
        if album is None:
            return None
        size = 300 if size <= 300 else 800
        out = self.cache_dir / "covers" / f"{album_id}_{size}.jpg"
        missing = self.cache_dir / "covers" / f"{album_id}.none"
        if out.exists():
            return out
        if missing.exists() and missing.stat().st_mtime > album.added:
            return None
        data = self._cover_source(album)
        if not data:
            missing.touch()
            return None
        try:
            img = Image.open(io.BytesIO(data)).convert("RGB")
            img.thumbnail((size, size), Image.LANCZOS)
            img.save(out, "JPEG", quality=86)
            return out
        except Exception:
            missing.touch()
            return None


def embedded_art(path: Path) -> bytes | None:
    try:
        ext = path.suffix.lower()
        if ext == ".flac":
            pics = FLAC(path).pictures
            return pics[0].data if pics else None
        if ext == ".mp3":
            frames = ID3(path).getall("APIC")
            return frames[0].data if frames else None
        if ext in (".m4a", ".mp4", ".aac"):
            covr = (MP4(path).tags or {}).get("covr")
            return bytes(covr[0]) if covr else None
        f = mutagen.File(path)
        pics = getattr(f, "pictures", None)
        return pics[0].data if pics else None
    except Exception:
        return None


# ---------- public catalogue lookups ----------
def _http(url: str, binary: bool = False):
    req = urllib.request.Request(url, headers={"User-Agent": "music-site/1.0"})
    with urllib.request.urlopen(req, timeout=8) as r:
        data = r.read()
    return data if binary else json.loads(data.decode("utf-8", "replace"))


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (s or "").lower())


def find_artwork(artist: str, album: str, title: str, artist_photo: bool = True) -> str | None:
    """Return a large cover image URL for the release, or None. Only accepts results whose artist matches."""
    a = _norm(artist.split("/")[0].split(",")[0].split("&")[0])
    queries = []
    if album and _norm(album) != _norm(title):
        queries.append(("album", f"{artist} {album}".strip()))
    queries.append(("song", f"{artist} {title}".strip()))

    def artist_ok(name: str) -> bool:
        n = _norm(name)
        return bool(a) and (a in n or n in a)

    def core(text: str) -> str:
        return _norm(re.sub(r"[\(\[].*?[\)\]]", "", text or ""))  # drop "(unreleased)", "[Remix]" etc.

    def same_release(name: str, wanted: str) -> bool:
        """Titles must match and carry the same numbers ("Part 12" is not "Part 11")."""
        if re.findall(r"\d+", name or "") != re.findall(r"\d+", wanted or ""):
            return False
        w, n = core(wanted), core(name)
        return bool(w) and (w == n or w in n or n in w)

    for entity, term in queries:
        try:
            q = urllib.parse.urlencode({"term": term, "media": "music", "entity": entity, "limit": 10})
            for r in _http(f"https://itunes.apple.com/search?{q}").get("results", []):
                name = r.get("collectionName" if entity == "album" else "trackName", "")
                if (artist_ok(r.get("artistName", "")) and r.get("artworkUrl100")
                        and same_release(name, album if entity == "album" else title)):
                    return r["artworkUrl100"].replace("100x100bb", "1000x1000bb")
        except Exception:
            pass
        try:
            q = urllib.parse.urlencode({"q": term})
            kind = "album" if entity == "album" else "track"
            for r in _http(f"https://api.deezer.com/search/{kind}?{q}").get("data", []):
                cover = (r.get("cover_xl") if kind == "album" else (r.get("album") or {}).get("cover_xl"))
                name = r.get("title", "")
                if (artist_ok((r.get("artist") or {}).get("name", "")) and cover
                        and same_release(name, album if kind == "album" else title)):
                    return cover
        except Exception:
            pass
    # Nothing for this release (e.g. unreleased): fall back to the artist's photo,
    # but only when the artist name is trustworthy (tags or "Artist - Title"), not an uploader name.
    if not artist_photo:
        return None
    try:
        q = urllib.parse.urlencode({"q": artist})
        for r in _http(f"https://api.deezer.com/search/artist?{q}").get("data", []):
            if artist_ok(r.get("name", "")) and r.get("picture_xl") and "/artist//" not in r["picture_xl"]:
                return r["picture_xl"]
    except Exception:
        pass
    return None
