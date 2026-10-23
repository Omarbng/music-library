MUSIC LIBRARY ON WINDOWS
========================

This folder runs two things on a Windows PC:
  - a Telegram uploader that sends your music to a private Telegram channel
  - a private music website to browse, play and download your music

Everything happens in the "windows" folder by double-clicking the .bat files.


BEFORE YOU START
----------------
1. Put the music on this PC. By default the tools read C:\Users\<you>\Music.
   If your music is somewhere else, double-click edit-settings.bat and set, for example:
       MUSIC_DIR=D:\Music
   then save and close Notepad.

2. Have these ready for the Telegram account you will upload to:
   - App api_id and App api_hash  (from https://my.telegram.org > API development tools)
   - the phone that receives that account's Telegram login codes
   Only use a Telegram account you own or have the owner's permission to use.


STEP 1 - INSTALL (once)
-----------------------
First extract the zip: right-click music-library-windows.zip > Extract All... > Extract.
Don't run the .bat files from inside the zip - they need the other project files next to them.

Double-click 1-install.bat.
It installs "uv" and Python for this project. It needs an internet connection and
takes a few minutes the first time.


STEP 2 - UPLOAD TO TELEGRAM
---------------------------
Double-click 2-upload-to-telegram.bat.

The first time it asks for:
  1. App api_id      (a number)
  2. App api_hash    (32 letters and numbers; hidden while you paste - that's normal)
  3. Phone number    with country code, e.g. +971...
  4. Login code      Telegram sends it to that account's Telegram app
  5. Two-step password, only if that account has one

It then shows what will be uploaded and asks Y/N before starting.
It creates a private channel called "Music Library" and posts each album with its
cover, then every song as a playable audio file.

You can close the window at any time. Run it again later and it continues where it
stopped; songs already uploaded are skipped.

To upload only some albums, open Command Prompt in this project folder and run:
    windows\2-upload-to-telegram.bat --only "artist or album name"

To skip folders (for example work recordings), add their names to EXCLUDE in
edit-settings.bat, separated by commas:
    EXCLUDE=rekordbox,Unknown Artist


STEP 3 - MUSIC WEBSITE (optional)
---------------------------------
Double-click 3-start-music-site.bat and keep the window open.
  - On this PC:              http://localhost:8765
  - On phones on the Wi-Fi:  the "network" address printed in the window
The password is the PASSWORD line in edit-settings.bat.
Windows may ask whether to allow network access - allow it on Private networks.


KEEP THESE PRIVATE
------------------
  .cache\telegram.session   - this file IS the Telegram login. Anyone with it can use
                              that Telegram account. Never copy or share it.
  .env                      - holds the API keys and the website password.
To sign this PC out of Telegram: in Telegram, Settings > Devices > end the
"Music uploader" session, and delete .cache\telegram.session.

STEP 4 - MUSIC WEBSITE FROM TELEGRAM (no music files needed on the PC)
-----------------------------------------------------------------------
Double-click 4-music-site-from-telegram.bat and keep the window open.
The website reads the private "Music Library" channel and plays, downloads and
zips albums straight from Telegram.

The first time, it signs in to Telegram separately from the uploader:
  1. Phone number with country code, e.g. +971...
  2. The 5-digit code Telegram sends to that account's Telegram app
  3. Two-step password, only if the account has one
Then open http://localhost:8765 (password: PASSWORD line in edit-settings.bat).

New uploads appear after pressing the refresh button at the top of the website.
To use a channel with a different name, add TG_CHANNEL_TITLE=Your Channel Name
in edit-settings.bat.
The website's Telegram login is stored in .cache\telegram_site.session - keep it private.
