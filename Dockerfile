# Container for the music website in Telegram mode (Hugging Face Spaces, Render, any Docker host).
FROM python:3.12-slim

# Hugging Face runs containers as user 1000.
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    MUSIC_CLOUD=1 \
    STORAGE=local \
    HOST=0.0.0.0 \
    PORT=7860
WORKDIR /home/user/app

COPY --chown=user requirements.txt .
RUN pip install --no-cache-dir --user -r requirements.txt

COPY --chown=user app.py library.py storage_telegram.py storage_r2.py ./
COPY --chown=user static ./static

EXPOSE 7860
CMD ["python", "app.py"]
