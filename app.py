"""Private music website: browse, play and download your own library.

Run:  uv run app.py
Settings live in .env next to this file (created on first run).
"""

from __future__ import annotations

import asyncio
import hmac
import os
import re
import secrets
import socket
import time
from pathlib import Path
from urllib.parse import quote

import uvicorn
import zipstream
from contextlib import asynccontextmanager

from fastapi import FastAPI, Form, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import (FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response,
                               StreamingResponse)
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from library import Library

HERE = Path(__file__).resolve().parent
ENV_FILE = Path(os.environ.get("MUSIC_SITE_ENV") or HERE / ".env")


# ---------- settings ----------
IS_CLOUD = bool(os.environ.get("MUSIC_CLOUD") or os.environ.get("SPACE_ID") or os.environ.get("RENDER"))
ENV_KEYS = ("MUSIC_DIR", "EXCLUDE", "PASSWORD", "SECRET_KEY", "HOST", "PORT", "STORAGE", "TG_API_ID", "TG_API_HASH",
            "TG_SESSION", "TG_CHANNEL_TITLE", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET",
            "SITE_NAME", "SITE_ARTIST", "HF_DATASET", "HF_TOKEN", "NAV_LINK")


def load_settings() -> dict:
    """Read .env, adding any missing settings with sensible defaults (works on macOS, Windows, Linux)."""
    defaults = [
        ("MUSIC_DIR", str(Path.home() / "Music"), "Folder that holds your music."),
        ("EXCLUDE", "rekordbox", "Comma-separated folder names to skip anywhere in the library."),
        ("PASSWORD", secrets.token_urlsafe(12), "Password for the website."),
        ("SECRET_KEY", secrets.token_hex(32), "Signs login cookies. Changing it signs everyone out."),
        ("HOST", "0.0.0.0", "0.0.0.0 lets other devices on your network open the site; 127.0.0.1 keeps it local."),
        ("PORT", "8765", ""),
    ]
    text = ENV_FILE.read_text() if ENV_FILE.exists() else "# Music site settings. Restart the server after editing.\n"
    settings = {}
    for line in text.splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            settings[key.strip()] = (lambda _v: _v[1:-1] if len(_v) >= 2 and _v[0] == _v[-1] and _v[0] in "\"'" else _v)(value.strip())
    # On a cloud host, settings come from the host's secrets / environment variables.
    for key in ENV_KEYS:
        if os.environ.get(key):
            settings[key] = os.environ[key]
    if IS_CLOUD and not os.environ.get("PASSWORD"):
        raise SystemExit("Set a PASSWORD secret on your host (it is the website password).")
    added = []
    for key, value, comment in defaults:
        if not settings.get(key):
            settings[key] = value
            added.append((f"# {comment}\n" if comment else "") + f"{key}={value}\n")
    if IS_CLOUD:
        return settings  # don't write secrets to the container's disk
    if added or not ENV_FILE.exists():
        if text and not text.endswith("\n"):
            text += "\n"
        # Drop empty "KEY=" lines that are being filled in, then append the new values.
        filled = {k for k, _, _ in defaults}
        kept = [l for l in text.splitlines(keepends=True)
                if not (l.split("=", 1)[0].strip() in filled and l.strip().endswith("=") and "=" in l)]
        ENV_FILE.write_text("".join(kept) + "".join(added))
        try:
            os.chmod(ENV_FILE, 0o600)
        except OSError:
            pass
    return settings


S = load_settings()
library = Library(Path(S["MUSIC_DIR"]), S.get("EXCLUDE", "").split(","), HERE / ".cache")

# STORAGE=local serves files from MUSIC_DIR; r2 serves them from Cloudflare R2;
# telegram serves them from the private Telegram channel made by telegram_upload.py.
STORAGE = (os.environ.get("MUSIC_STORAGE") or S.get("STORAGE", "local")).strip().lower()
r2 = None
tg = None
tg_covers: dict[str, int] = {}
if STORAGE == "r2":
    from storage_r2 import INDEX_KEY, R2
    r2 = R2(S)
elif STORAGE == "telegram":
    from storage_telegram import TelegramStore
    tg = TelegramStore(S, HERE / ".cache")


async def tg_refresh(full: bool = False) -> dict:
    data = await tg.build_index(full=full)
    tg_covers.clear()
    tg_covers.update(data.get("covers", {}))
    return library.load_index(data)


@asynccontextmanager
async def lifespan(_app):
    if tg is not None:
        await tg.connect()
        result = await tg_refresh()
        print(f"Library: {result['albums']} albums, {result['tracks']} tracks from the Telegram channel")
    yield
    if tg is not None:
        await tg.disconnect()


def refresh_library() -> dict:
    if r2 is None:
        return library.scan()
    data = r2.get_json(INDEX_KEY)
    if data is None:
        data = {"root": str(library.root), "tracks": []}
        print("R2 has no library index yet. Run: uv run r2_sync.py")
    return library.load_index(data)

app = FastAPI(title="Music", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)


# ---------- auth ----------
_failures: dict[str, list[float]] = {}


def _too_many(ip: str) -> bool:
    now = time.time()
    recent = [t for t in _failures.get(ip, []) if now - t < 300]
    _failures[ip] = recent
    return len(recent) >= 8


@app.middleware("http")
async def require_login(request: Request, call_next):
    path = request.url.path
    public = path in ("/login", "/favicon.svg") or path.startswith("/static/login")
    if not public and not request.session.get("ok"):
        if path.startswith(("/api/", "/stream/", "/download/", "/cover/")):
            return JSONResponse({"error": "login required"}, status_code=401)
        return RedirectResponse("/login", status_code=303)
    return await call_next(request)


# Added after require_login so it runs first and loads the session for it.
# On HTTPS cloud hosts the cookie must be Secure and SameSite=None so sign-in also works
# when the site is shown inside the host's page (Hugging Face shows Spaces in a frame).
app.add_middleware(SessionMiddleware, secret_key=S["SECRET_KEY"], session_cookie="music_session",
                   max_age=60 * 60 * 24 * 30, same_site="none" if IS_CLOUD else "lax", https_only=IS_CLOUD)


@app.get("/login", response_class=HTMLResponse)
def login_page():
    return (HERE / "static" / "login.html").read_text()


@app.post("/login")
def login(request: Request, password: str = Form(...)):
    ip = request.client.host if request.client else "?"
    if _too_many(ip):
        return RedirectResponse("/login?error=wait", status_code=303)
    if hmac.compare_digest(password.encode(), S["PASSWORD"].encode()):
        request.session["ok"] = True
        _failures.pop(ip, None)
        return RedirectResponse("/", status_code=303)
    _failures.setdefault(ip, []).append(time.time())
    time.sleep(0.6)
    return RedirectResponse("/login?error=1", status_code=303)


@app.post("/logout")
def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/login", status_code=303)


# ---------- pages ----------
@app.get("/", response_class=HTMLResponse)
def index():
    return (HERE / "static" / "index.html").read_text()


@app.get("/favicon.svg")
def favicon():
    return FileResponse(HERE / "static" / "favicon.svg", media_type="image/svg+xml")


app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")


# ---------- library API ----------
VARIOUS = {"various artists", "various", "va"}


def _album_artist(a) -> str:
    """Show the real artist when a compilation track sits alone (e.g. one Butch track from a VA release)."""
    if a.artist.lower() in VARIOUS:
        artists = {library.tracks[t].artist for t in a.track_ids}
        if len(artists) == 1:
            return artists.pop()
    return a.artist


def _display_title(t) -> str:
    """Tell apart versions with the same title in one record (e.g. the MP3 and Opus of a track)."""
    album = library.albums.get(t.album_id)
    if album and sum(1 for x in album.track_ids if library.tracks[x].title == t.title) > 1:
        return f"{t.title} · {t.codec}"
    return t.title


def _album_json(a, with_tracks=False):
    data = {
        "id": a.id, "title": a.title, "artist": _album_artist(a), "year": a.year, "edition": a.edition,
        "genre": a.genre, "tracks": len(a.track_ids), "duration": round(a.duration), "size": a.size,
        "added": a.added, "lossless": a.lossless, "quality": a.quality,
    }
    if with_tracks:
        data["trackList"] = [_track_json(library.tracks[t]) for t in a.track_ids]
    return data


def _track_json(t):
    return {
        "id": t.id, "title": _display_title(t), "artist": t.artist, "album": t.album, "albumId": t.album_id,
        "trackNo": t.track_no, "discNo": t.disc_no, "duration": round(t.duration, 2),
        "quality": t.quality, "lossless": t.lossless, "size": t.size, "added": t.mtime,
        "format": Path(t.path).suffix.lower().lstrip("."),
    }


DEFAULT_NAV_LINK = "Lucida|https://lucida.to/"


def _nav_link():
    """Extra link in the top bar for finding new music. NAV_LINK=Label|https://url changes it, NAV_LINK=off hides it."""
    raw = (S.get("NAV_LINK", "") or DEFAULT_NAV_LINK).strip()
    if "|" not in raw:
        return None
    label, url = (x.strip() for x in raw.split("|", 1))
    return {"label": label, "url": url} if label and url.startswith(("https://", "http://")) else None


@app.get("/api/library")
def api_library():
    return {
        "albums": [_album_json(a) for a in library.albums.values()],
        "tracks": [_track_json(t) for t in library.tracks.values()],
        "siteName": S.get("SITE_NAME", "") or "void crate",
        "siteArtist": S.get("SITE_ARTIST", ""),
        "navLink": _nav_link(),
        "scannedAt": library.scanned_at,
        "scanning": library.scanning,
        "root": str(library.root),
    }


@app.get("/api/albums/{album_id}")
def api_album(album_id: str):
    album = library.albums.get(album_id)
    if album is None:
        raise HTTPException(404, "album not found")
    return _album_json(album, with_tracks=True)


@app.post("/api/rescan")
async def api_rescan():
    if library.scanning:
        return {"status": "already scanning"}
    if tg is not None:
        return await tg_refresh(full=True)
    return await run_in_threadpool(refresh_library)


# ---------- media ----------
MEDIA_TYPES = {".mp3": "audio/mpeg", ".flac": "audio/flac", ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".aac": "audio/aac",
               ".wav": "audio/wav", ".aif": "audio/aiff", ".aiff": "audio/aiff", ".ogg": "audio/ogg",
               ".opus": "audio/ogg"}


def _track_or_404(track_id: str):
    track = library.tracks.get(track_id)
    if track is None or (r2 is None and tg is None and not Path(track.path).is_file()):
        raise HTTPException(404, "track not found")
    return track


def _attachment(name: str) -> str:
    ascii_name = name.encode("ascii", "replace").decode().replace('"', "'")
    return f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quote(name)}'


def _tg_msg_id(track) -> int:
    return int(track.key.split(":", 1)[1])


def _tg_file_response(track, request: Request | None, download: bool):
    """Stream a Telegram-stored file, honouring HTTP Range requests so the player can seek."""
    size = track.size
    name = Path(track.path).name
    media_type = "application/octet-stream" if download else MEDIA_TYPES.get(Path(name).suffix.lower(), "audio/mpeg")
    headers = {"Accept-Ranges": "bytes"}
    if download:
        headers["Content-Disposition"] = _attachment(name)
    start, end, status = 0, size - 1, 200
    rng = request.headers.get("range") if request is not None else None
    m = re.fullmatch(r"bytes=(\d*)-(\d*)", rng.strip()) if rng else None
    if m and (m.group(1) or m.group(2)):
        if m.group(1) == "":
            start = max(0, size - int(m.group(2)))
        else:
            start = int(m.group(1))
            end = int(m.group(2)) if m.group(2) else size - 1
        if start >= size:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
        end = min(end, size - 1)
        status = 206
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    headers["Content-Length"] = str(end - start + 1)
    return StreamingResponse(tg.iter_bytes(_tg_msg_id(track), start, end, size), status_code=status,
                             media_type=media_type, headers=headers)


@app.get("/stream/{track_id}")
async def stream(track_id: str, request: Request):
    track = _track_or_404(track_id)
    if tg is not None:
        return _tg_file_response(track, request, download=False)
    if r2 is not None:
        return RedirectResponse(r2.presign(track.key), status_code=307)
    path = Path(track.path)
    return FileResponse(path, media_type=MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream"))


@app.get("/download/track/{track_id}")
async def download_track(track_id: str, request: Request):
    track = _track_or_404(track_id)
    if tg is not None:
        return _tg_file_response(track, request, download=True)
    path = Path(track.path)
    if r2 is not None:
        return RedirectResponse(r2.presign(track.key, download_name=path.name), status_code=307)
    return FileResponse(path, media_type="application/octet-stream",
                        headers={"Content-Disposition": _attachment(path.name)})


def _tg_sync_bytes(msg_id: int, size: int, loop):
    """Iterate a Telegram file from a worker thread (zipstream is synchronous)."""
    agen = tg.iter_bytes(msg_id, 0, None, size)
    try:
        while True:
            try:
                chunk = asyncio.run_coroutine_threadsafe(agen.__anext__(), loop).result()
            except StopAsyncIteration:
                break
            yield chunk
    finally:
        asyncio.run_coroutine_threadsafe(agen.aclose(), loop).result()


@app.get("/download/album/{album_id}")
async def download_album(album_id: str):
    album = library.albums.get(album_id)
    if album is None:
        raise HTTPException(404, "album not found")
    folder_name = f"{album.artist} - {album.title}" + (f" [{album.edition}]" if album.edition else "")
    folder_name = folder_name.replace("/", "-").replace(":", "-")
    zs = zipstream.ZipStream(compress_type=zipstream.ZIP_STORED, sized=True)
    for tid in album.track_ids:
        t = library.tracks[tid]
        path = Path(t.path)
        if tg is not None:
            zs.add(_tg_sync_bytes(_tg_msg_id(t), t.size, asyncio.get_running_loop()),
                   f"{folder_name}/{path.name}", size=t.size)
        elif r2 is not None:
            zs.add(r2.iter_object(t.key), f"{folder_name}/{path.name}", size=t.size)
        elif path.is_file():
            zs.add_path(str(path), f"{folder_name}/{path.name}")
    cover = await get_cover_async(album.id, 800)
    if cover:
        zs.add_path(str(cover), f"{folder_name}/cover.jpg")
    return StreamingResponse(zs, media_type="application/zip", headers={
        "Content-Disposition": _attachment(f"{folder_name}.zip"),
        "Content-Length": str(len(zs)),
    })


@app.get("/cover/{album_id}")
async def cover(album_id: str, size: int = 300):
    path = await get_cover_async(album_id, size)
    if path is None:
        raise HTTPException(404, "no cover")
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})


def get_cover(album_id: str, size: int) -> Path | None:
    """Cover art path, fetched from R2 into the local cache when running in R2 mode."""
    if r2 is None:
        return library.cover(album_id, size)
    if album_id not in library.albums:
        return None
    size = 300 if size <= 300 else 800
    covers = library.cache_dir / "covers"
    covers.mkdir(parents=True, exist_ok=True)
    path = covers / f"r2_{album_id}_{size}.jpg"
    missing = covers / f"r2_{album_id}_{size}.none"
    if path.exists():
        return path
    if missing.exists() and time.time() - missing.stat().st_mtime < 3600:
        return None
    data = r2.get_bytes(f"covers/{album_id}_{size}.jpg")
    if not data:
        missing.touch()
        return None
    path.write_bytes(data)
    return path


async def get_cover_async(album_id: str, size: int) -> Path | None:
    if tg is None:
        return await run_in_threadpool(get_cover, album_id, size)
    album = library.albums.get(album_id)
    msg_id = tg_covers.get(album.folder) if album else None
    if msg_id is None:
        return None
    size = 300 if size <= 300 else 800
    covers = library.cache_dir / "covers"
    covers.mkdir(parents=True, exist_ok=True)
    path = covers / f"tg_{msg_id}_{size}.jpg"
    if not path.exists():
        try:
            data = await tg.cover_bytes(msg_id, size)
        except Exception:
            data = None
        if not data:
            return None
        path.write_bytes(data)
    return path


# ---------- startup ----------
def _lan_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.168.0.1", 1))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def fetch_hf_dataset() -> None:
    """Cloud: copy the music from a private Hugging Face dataset into the container, then serve it locally."""
    repo = S.get("HF_DATASET", "").strip()
    if not repo:
        return
    from huggingface_hub import snapshot_download
    target = HERE / "music"
    print(f"Downloading music from the private dataset {repo} ...")
    snapshot_download(repo_id=repo, repo_type="dataset", local_dir=str(target),
                      token=S.get("HF_TOKEN") or None, max_workers=4)
    library.root = target.resolve()


def main():
    fetch_hf_dataset()
    if tg is not None:
        tg.ensure_login()  # asks for phone number and code in this window the first time
    elif r2 is None and not library.root.is_dir():
        raise SystemExit(f"Music folder not found: {library.root}  (edit MUSIC_DIR in {ENV_FILE})")
    if r2 is not None:
        r2.check_access()
    if tg is None:
        result = refresh_library()
        source = f"Cloudflare R2 bucket '{r2.bucket}'" if r2 is not None else str(library.root)
        print(f"Library: {result['albums']} albums, {result['tracks']} tracks from {source}")
    port = int(os.environ.get("PORT") or S.get("PORT", 8765))
    host = S.get("HOST", "0.0.0.0")
    if IS_CLOUD:
        print(f"Website running on port {port}. Password: the PASSWORD secret set on the host.")
    else:
        print(f"Open on this computer: http://localhost:{port}")
        if host == "0.0.0.0":
            print(f"Open on your network: http://{_lan_ip()}:{port}")
        print(f"Password is in {ENV_FILE}")
    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
