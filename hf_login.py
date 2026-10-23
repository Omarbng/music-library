"""Sign this computer in to Hugging Face with an access token (hidden while you paste).

Usage:  uv run hf_login.py
Create the token at https://huggingface.co/settings/tokens (type: Write).
"""

import getpass
import sys

from huggingface_hub import HfApi, login

print("Paste your Hugging Face access token below and press Return.")
print("Nothing will appear while you paste - that's normal.\n")
token = getpass.getpass("Token: ").strip()
if not token.startswith("hf_"):
    sys.exit("That doesn't look like a Hugging Face token (they start with hf_). Run this again.")
try:
    user = HfApi(token=token).whoami()["name"]
except Exception as e:
    sys.exit(f"Hugging Face didn't accept that token ({type(e).__name__}). Copy it again and run this again.")
login(token=token, add_to_git_credential=False)
print(f"\nLogged in to Hugging Face as {user}. You can close this tab and tell Claude to deploy.")
