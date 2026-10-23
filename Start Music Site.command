#!/bin/zsh
# Double-click to start your music website. Close this window to stop it.
cd "${0:A:h}"
exec "$HOME/.local/bin/uv" run app.py
