"""Save your Cloudflare R2 keys into .env and test them.

Usage:  uv run setup_r2.py
You'll be asked for the endpoint, Access Key ID and Secret Access Key that
Cloudflare shows after you create an R2 API token (Object Read & Write).
"""

from __future__ import annotations

import getpass
import re
import sys

from storage_r2 import ENV_FILE, R2, load_env


def ask(prompt: str, secret: bool = False, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    while True:
        value = (getpass.getpass if secret else input)(f"{prompt}{suffix}: ").strip().strip('"').strip("'")
        if value or default:
            return value or default
        print("  This one is required.")


def set_values(values: dict[str, str]) -> None:
    lines = ENV_FILE.read_text().splitlines() if ENV_FILE.exists() else []
    seen = set()
    out = []
    for line in lines:
        key = line.split("=", 1)[0].strip()
        if key in values and not line.lstrip().startswith("#"):
            if key in seen:
                continue  # drop duplicate lines so the new value wins
            out.append(f"{key}={values[key]}")
            seen.add(key)
        else:
            out.append(line)
    for key, value in values.items():
        if key not in seen:
            out.append(f"{key}={value}")
    ENV_FILE.write_text("\n".join(out) + "\n")
    ENV_FILE.chmod(0o600)


def main():
    print("Paste the values Cloudflare showed when you created the R2 API token.\n")
    endpoint = ask("Endpoint (https://<account_id>.r2.cloudflarestorage.com)")
    if not endpoint.startswith("https://"):
        endpoint = "https://" + endpoint
    endpoint = endpoint.rstrip("/")
    endpoint = re.sub(r"(\.r2\.cloudflarestorage\.com)/.*$", r"\1", endpoint)  # drop a pasted /bucket suffix
    if ".r2.cloudflarestorage.com" not in endpoint:
        print("  Note: R2 endpoints usually end in .r2.cloudflarestorage.com — check this if the test fails.")
    key_id = ask("Access Key ID")
    secret = ask("Secret Access Key (hidden as you type)", secret=True)
    bucket = ask("Bucket name", default=load_env().get("R2_BUCKET") or "music")

    set_values({"R2_ENDPOINT": endpoint, "R2_ACCESS_KEY_ID": key_id,
                "R2_SECRET_ACCESS_KEY": secret, "R2_BUCKET": bucket})
    print(f"\nSaved to {ENV_FILE}. Testing the connection...")

    try:
        r2 = R2(load_env())
        r2.check_access()
        objects = r2.list_sizes()
    except SystemExit as e:
        print(f"Connection failed: {e}")
        print("Run this again with the correct values.")
        sys.exit(1)
    except Exception as e:  # network or credential errors from boto3
        print(f"Connection failed: {type(e).__name__}: {str(e)[:200]}")
        print("Check the values and run this again.")
        sys.exit(1)
    print(f"Connected to bucket '{bucket}' ({len(objects)} files in it now).")
    print("Next: uv run r2_sync.py --dry-run")


if __name__ == "__main__":
    main()
