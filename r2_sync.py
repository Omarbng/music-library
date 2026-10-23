"""Upload your local music library to Cloudflare R2.

Only new or changed files are uploaded, so you can run it again any time.
It stops before going past R2's free 10 GB unless you pass --allow-paid.

Usage:
  uv run r2_sync.py --dry-run          # show what would be uploaded and what it would cost
  uv run r2_sync.py                    # upload (stays within the free 10 GB)
  uv run r2_sync.py --only eastmynd    # only albums whose artist, title or folder match
  uv run r2_sync.py --allow-paid       # allow going over 10 GB ($0.015 per GB each month)
"""

from __future__ import annotations

import argparse
import sys
import threading
import time
from dataclasses import asdict
from pathlib import Path

from library import Library
from storage_r2 import FREE_BYTES, INDEX_KEY, PRICE_PER_GB_MONTH, R2, load_env, track_key

HERE = Path(__file__).resolve().parent


def fmt_size(n: float) -> str:
    return f"{n / 1e9:.2f} GB" if n >= 1e9 else f"{n / 1e6:.1f} MB"


def monthly_cost(total_bytes: int) -> float:
    over = max(0, total_bytes - FREE_BYTES) / 1024**3
    return over * PRICE_PER_GB_MONTH


class Progress:
    def __init__(self, label: str, total: int):
        self.label, self.total, self.sent = label, total, 0
        self.start = self.last = time.time()
        self.lock = threading.Lock()

    def __call__(self, n: int):
        with self.lock:
            self.sent += n
            now = time.time()
            if now - self.last < 0.5 and self.sent < self.total:
                return
            self.last = now
            pct = 100 * self.sent / self.total if self.total else 100
            speed = self.sent / max(now - self.start, 0.001)
            sys.stdout.write(f"\r    {self.label[:48]:48} {pct:5.1f}%  {fmt_size(self.sent):>9} "
                             f"of {fmt_size(self.total):<9} {speed / 1e6:5.1f} MB/s ")
            sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser(description="Upload your music library to Cloudflare R2.")
    parser.add_argument("--dry-run", action="store_true", help="only show what would be uploaded")
    parser.add_argument("--only", help="only albums whose artist, title or folder contains this text")
    parser.add_argument("--allow-paid", action="store_true", help="allow storing more than the free 10 GB")
    args = parser.parse_args()

    env = load_env()
    lib = Library(Path(env.get("MUSIC_DIR", Path.home() / "Music")), env.get("EXCLUDE", "rekordbox").split(","),
                  HERE / ".cache")
    scan = lib.scan()
    print(f"Local library: {scan['albums']} albums, {scan['tracks']} tracks in {lib.root}")

    r2 = R2(env)
    r2.check_access()
    remote = r2.list_sizes()
    remote_total = sum(remote.values())

    needle = (args.only or "").lower()
    selected = [a for a in lib.albums.values()
                if not needle or needle in f"{a.artist} {a.title} {a.edition}".lower()]
    selected.sort(key=lambda a: (a.artist.lower(), a.title.lower(), a.edition))

    uploads = []  # (album, track, key)
    for album in selected:
        for tid in album.track_ids:
            t = lib.tracks[tid]
            key = track_key(t.path, lib.root)
            if remote.get(key) != t.size:
                uploads.append((album, t, key))
    new_bytes = sum(t.size for _, t, key in uploads) - sum(remote.get(key, 0) for _, _, key in uploads)
    after = remote_total + new_bytes

    print(f"In R2 now: {fmt_size(remote_total)}. To upload: {len(uploads)} tracks, "
          f"{fmt_size(sum(t.size for _, t, _ in uploads))}.")
    print(f"Bucket after upload: {fmt_size(after)} — "
          + ("within the free 10 GB." if after <= FREE_BYTES
             else f"about ${monthly_cost(after):.2f} a month for the part over the free 10 GB."))

    if args.dry_run:
        current = None
        for album, t, _ in uploads:
            if album is not current:
                current = album
                edition = f" [{album.edition}]" if album.edition else ""
                print(f"  {album.artist} — {album.title}{edition}")
            print(f"      {Path(t.path).name}  ({fmt_size(t.size)})")
        return

    if after > FREE_BYTES and not args.allow_paid:
        raise SystemExit("Stopped: this would go over R2's free 10 GB. Use --only to upload less, "
                         "or run again with --allow-paid to accept the monthly cost.")

    done = 0
    current = None
    try:
        for album, t, key in uploads:
            if album is not current:
                current = album
                edition = f" [{album.edition}]" if album.edition else ""
                print(f"\n{album.artist} — {album.title}{edition}")
            path = Path(t.path)
            r2.upload_file(path, key, progress=Progress(path.name, t.size),
                           metadata={"title": t.title, "artist": t.artist, "album": t.album})
            remote[key] = t.size
            done += 1
            sys.stdout.write("\r    ✓ " + path.name[:70].ljust(90) + "\n")
    except KeyboardInterrupt:
        print("\nStopped. Already-uploaded files are kept; run again to continue.")
    finally:
        publish_index(r2, lib, remote)
    print(f"\nUploaded {done} tracks. The website index now lists everything stored in R2.")


def publish_index(r2: R2, lib: Library, remote: dict[str, int]) -> None:
    """Upload cover art and the track list for every track that is in the bucket."""
    tracks = []
    album_ids = set()
    for t in lib.tracks.values():
        key = track_key(t.path, lib.root)
        if remote.get(key) == t.size:
            d = asdict(t)
            d["key"] = key
            tracks.append(d)
            album_ids.add(t.album_id)
    for aid in album_ids:
        for size in (300, 800):
            cover_key = f"covers/{aid}_{size}.jpg"
            if cover_key in remote:
                continue
            path = lib.cover(aid, size)
            if path:
                r2.upload_file(Path(path), cover_key)
                remote[cover_key] = Path(path).stat().st_size
    r2.put_json(INDEX_KEY, {"root": str(lib.root), "updated": time.time(), "tracks": tracks})
    print(f"Published index: {len(tracks)} tracks in {len(album_ids)} albums.")


if __name__ == "__main__":
    main()
