FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 \
    PORT=8000 \
    APP_ROOT=/app \
    DB_PATH=/data/database/database.sqlite \
    PUBLIC_DIR=/data/public \
    PRIVATE_UPLOAD_DIR=/data/private/checkout-verify

WORKDIR /app

COPY . /app
RUN pip install --no-cache-dir -r requirements.txt
RUN mkdir -p /data/public /data/private/checkout-verify /data/database

EXPOSE 8000

CMD ["python", "tools/docker_entrypoint.py"]
