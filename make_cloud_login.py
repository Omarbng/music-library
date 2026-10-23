"""Create a Telegram login for the cloud-hosted website (Hugging Face Spaces, Render, ...).

Run it once on your PC:  uv run make_cloud_login.py
It signs in with a phone number and code, then prints a long "session string".
Paste that string into your host's secret named TG_SESSION.

The string is a full login to the Telegram account: keep it only in the host's
secret settings. To revoke it, end the "Music website (cloud)" session in
Telegram > Settings > Devices.
"""

from __future__ import annotations

import asyncio

from telegram_upload import ask_for_keys, load_env


async def main():
    from telethon import TelegramClient
    from telethon.sessions import StringSession

    env = load_env()
    api_id, api_hash = env.get("TG_API_ID"), env.get("TG_API_HASH")
    if not api_id or not api_hash:
        api_id, api_hash = ask_for_keys()

    print("Signing in a NEW Telegram session for the cloud website.")
    print("Use the phone number of the account that owns the Music Library channel.\n")
    client = TelegramClient(StringSession(), int(api_id), api_hash,
                            device_model="Music website (cloud)", app_version="1.0")
    await client.start()
    me = await client.get_me()
    session = client.session.save()
    await client.disconnect()

    line = "=" * 72
    print(f"\nSigned in as {me.first_name}. Copy everything between the lines below")
    print("and paste it as the value of the secret TG_SESSION on your host.\n")
    print(line)
    print(session)
    print(line)
    print("\nDon't use this string anywhere else, and don't share it.")
    print(f"Also add these secrets on your host:  TG_API_ID={api_id}   TG_API_HASH=(the 32-character hash)")


if __name__ == "__main__":
    asyncio.run(main())
