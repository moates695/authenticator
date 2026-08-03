FROM python:3.12-slim

# Pinned to match the uv that produced uv.lock.
COPY --from=ghcr.io/astral-sh/uv:0.9.22 /uv /usr/local/bin/uv

WORKDIR /srv

ENV UV_PROJECT_ENVIRONMENT=/srv/.venv \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PYTHONUNBUFFERED=1 \
    PATH="/srv/.venv/bin:$PATH" \
    DB_PATH=/data/authenticator.db

# Dependencies resolve in their own layer so app changes do not re-download them.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

COPY app ./app

EXPOSE 8000

# One worker: SQLite has a single writer, and the load is a handful of requests
# per device per day. Access logging is off because the log would be a list of
# which accounts synced when.
CMD ["uvicorn", "app.main:create_app", "--factory", \
     "--host", "0.0.0.0", "--port", "8000", \
     "--workers", "1", "--no-access-log"]
