---
title: Music Library
emoji: 🎵
colorFrom: yellow
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

# Music Library

A private, password-protected music website. When the Space starts, it copies the music from a
private Hugging Face dataset (HF_DATASET) into the container and serves it — the music files are
never public. Deploy and update it with `uv run deploy_hf.py` from the project folder.

| Setting | Kind | Value |
|---|---|---|
| `PASSWORD` | secret | the website password |
| `SECRET_KEY` | secret | long random text (keeps people signed in across restarts) |
| `HF_TOKEN` | secret | a token that can read the private music dataset |
| `HF_DATASET` | variable | e.g. `your-name/music-library-files` |
