FROM python:3.12-slim

# Pinned to match the uv that produced uv.lock.
COPY --from=ghcr.io/astral-sh/uv:0.9.22 /uv /usr/local/bin/uv

WORKDIR /srv

# No DATABASE_URL default: it names a host and carries a password, so it comes
# from the environment and a container without one refuses to start.
ENV UV_PROJECT_ENVIRONMENT=/srv/.venv \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PYTHONUNBUFFERED=1 \
    PATH="/srv/.venv/bin:$PATH"

# Dependencies resolve in their own layer so app changes do not re-download them.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

COPY app ./app
# The one-shot SQLite import, run with `docker compose run` rather than by the
# service's own command. Nothing else in deploy/ runs in a container.
COPY deploy/migrate_sqlite_to_postgres.py ./deploy/

EXPOSE 8000

# One worker: the load is a handful of requests per device per day, and one
# process keeps the connection pool to a size the database is configured for.
# Access logging is off because the log would be a list of which accounts synced
# when.
CMD ["uvicorn", "app.main:create_app", "--factory", \
     "--host", "0.0.0.0", "--port", "8000", \
     "--workers", "1", "--no-access-log"]
