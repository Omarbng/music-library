"""Cloudflare R2 (S3-compatible) storage for the music site.

Settings in .env:
  R2_ENDPOINT            https://<account_id>.r2.cloudflarestorage.com
  R2_ACCESS_KEY_ID       from an R2 API token (Object Read & Write)
  R2_SECRET_ACCESS_KEY   from the same token
  R2_BUCKET              bucket name, e.g. music

Bucket layout:
  music/<path relative to MUSIC_DIR>   audio files
  covers/<album_id>_<300|800>.jpg      cover art
  index/library.json                   track list the website loads
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import boto3
from boto3.s3.transfer import TransferConfig
from botocore.config import Config
from botocore.exceptions import ClientError

HERE = Path(__file__).resolve().parent
ENV_FILE = Path(os.environ.get("MUSIC_SITE_ENV") or HERE / ".env")
INDEX_KEY = "index/library.json"
FREE_BYTES = 10 * 1024**3          # R2 free tier: 10 GB-month
PRICE_PER_GB_MONTH = 0.015         # USD, standard storage beyond the free tier

CONTENT_TYPES = {".mp3": "audio/mpeg", ".flac": "audio/flac", ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".aac": "audio/aac",
                 ".wav": "audio/wav", ".aif": "audio/aiff", ".aiff": "audio/aiff", ".ogg": "audio/ogg",
                 ".opus": "audio/ogg", ".jpg": "image/jpeg", ".json": "application/json"}


def load_env() -> dict:
    env = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = (lambda _v: _v[1:-1] if len(_v) >= 2 and _v[0] == _v[-1] and _v[0] in "\"'" else _v)(v.strip())
    return env


def track_key(track_path: str, root: Path) -> str:
    rel = Path(track_path).resolve().relative_to(root.resolve())
    return "music/" + rel.as_posix()


class R2:
    def __init__(self, env: dict):
        missing = [k for k in ("R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET") if not env.get(k)]
        if missing:
            raise SystemExit(
                "Missing R2 settings: " + ", ".join(missing) + "\n"
                f"Add them to {ENV_FILE}:\n"
                "  R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com\n"
                "  R2_ACCESS_KEY_ID=...\n"
                "  R2_SECRET_ACCESS_KEY=...\n"
                "  R2_BUCKET=music")
        self.bucket = env["R2_BUCKET"]
        self.s3 = boto3.client(
            "s3",
            endpoint_url=env["R2_ENDPOINT"],
            aws_access_key_id=env["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=env["R2_SECRET_ACCESS_KEY"],
            region_name="auto",
            config=Config(signature_version="s3v4", retries={"max_attempts": 5, "mode": "standard"}),
        )
        self.transfer = TransferConfig(multipart_threshold=64 * 1024**2, multipart_chunksize=64 * 1024**2,
                                       max_concurrency=4)

    # ----- listing & metadata -----
    def list_sizes(self, prefix: str = "") -> dict[str, int]:
        sizes = {}
        for page in self.s3.get_paginator("list_objects_v2").paginate(Bucket=self.bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                sizes[obj["Key"]] = obj["Size"]
        return sizes

    def check_access(self) -> None:
        try:
            self.s3.head_bucket(Bucket=self.bucket)
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code", "")
            raise SystemExit(f"Can't open bucket '{self.bucket}' ({code}). Check the bucket name, endpoint and "
                             "that the API token has Object Read & Write access to it.")

    # ----- upload -----
    def upload_file(self, path: Path, key: str, progress=None, metadata: dict | None = None) -> None:
        extra = {"ContentType": CONTENT_TYPES.get(path.suffix.lower(), "application/octet-stream")}
        if metadata:
            extra["Metadata"] = {k: str(v).encode("ascii", "replace").decode()[:1024] for k, v in metadata.items()}
        self.s3.upload_file(str(path), self.bucket, key, ExtraArgs=extra, Config=self.transfer, Callback=progress)

    def put_json(self, key: str, data) -> None:
        self.s3.put_object(Bucket=self.bucket, Key=key, Body=json.dumps(data).encode(),
                           ContentType="application/json")

    # ----- download -----
    def get_json(self, key: str):
        try:
            return json.loads(self.s3.get_object(Bucket=self.bucket, Key=key)["Body"].read())
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") in ("NoSuchKey", "404"):
                return None
            raise

    def get_bytes(self, key: str) -> bytes | None:
        try:
            return self.s3.get_object(Bucket=self.bucket, Key=key)["Body"].read()
        except ClientError:
            return None

    def iter_object(self, key: str, chunk: int = 1024 * 1024):
        body = self.s3.get_object(Bucket=self.bucket, Key=key)["Body"]
        try:
            yield from body.iter_chunks(chunk)
        finally:
            body.close()

    def presign(self, key: str, download_name: str | None = None, expires: int = 6 * 3600) -> str:
        params = {"Bucket": self.bucket, "Key": key}
        if download_name:
            from urllib.parse import quote
            ascii_name = download_name.encode("ascii", "replace").decode().replace('"', "'")
            params["ResponseContentDisposition"] = (
                f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quote(download_name)}')
        return self.s3.generate_presigned_url("get_object", Params=params, ExpiresIn=expires)
