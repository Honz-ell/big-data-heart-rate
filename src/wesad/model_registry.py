from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any

import psycopg
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from psycopg.rows import dict_row

MODEL_DIR = Path(os.getenv("MODEL_STORAGE_DIR", "models")).resolve()
VERSION_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
MAX_MODEL_BYTES = 200 * 1024 * 1024


def connect_db() -> psycopg.Connection[Any]:
    return psycopg.connect(
        host=os.getenv("DB_HOST", "localhost"),
        port=int(os.getenv("DB_PORT", "5432")),
        dbname=os.getenv("DB_NAME", "wesad"),
        user=os.getenv("DB_USER", "wesad"),
        password=os.getenv("DB_PASSWORD", "wesad_dev_password"),
        row_factory=dict_row,
        connect_timeout=5,
    )


def ensure_schema() -> None:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    with connect_db() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS model_versions (
                version TEXT PRIMARY KEY,
                model_file TEXT NOT NULL UNIQUE,
                sha256 TEXT NOT NULL,
                feature_schema_version TEXT NOT NULL DEFAULT 'v1',
                metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
                is_active BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                activated_at TIMESTAMPTZ
            )
            """
        )
        connection.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_model_versions_single_active "
            "ON model_versions (is_active) WHERE is_active"
        )


app = FastAPI(
    title="WESAD Edge Model Registry",
    version="1.0.0",
    description="Local registry for versioning and distributing Edge models.",
    on_startup=[ensure_schema],
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3001",
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    try:
        with connect_db() as connection:
            connection.execute("SELECT 1")
    except psycopg.Error as error:
        raise HTTPException(status_code=503, detail="PostgreSQL is unavailable") from error
    return {"status": "ok"}


@app.get("/models")
def list_models() -> list[dict[str, Any]]:
    with connect_db() as connection:
        rows = connection.execute(
            """
            SELECT version, model_file, sha256, feature_schema_version, metrics,
                   is_active, created_at, activated_at
            FROM model_versions
            ORDER BY created_at DESC, version
            """
        ).fetchall()
    return rows


@app.get("/models/active")
def get_active_model() -> dict[str, Any]:
    with connect_db() as connection:
        row = connection.execute(
            """
            SELECT version, model_file, sha256, feature_schema_version, metrics,
                   is_active, created_at, activated_at
            FROM model_versions
            WHERE is_active = TRUE
            """
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="No active model is registered")
    row["download_url"] = f"/models/{row['version']}/download"
    return row


@app.post("/models", status_code=201)
async def register_model(
    file: UploadFile = File(...),
    version: str = Form(...),
    activate: bool = Form(False),
    metrics: str = Form("{}"),
) -> dict[str, Any]:
    if not VERSION_PATTERN.fullmatch(version):
        raise HTTPException(status_code=422, detail="Invalid model version ID")
    try:
        parsed_metrics = json.loads(metrics)
    except json.JSONDecodeError as error:
        raise HTTPException(status_code=422, detail="metrics must be valid JSON") from error
    if not isinstance(parsed_metrics, dict):
        raise HTTPException(status_code=422, detail="metrics must be a JSON object")

    model_file = f"{version}.joblib"
    destination = MODEL_DIR / model_file
    temporary = MODEL_DIR / f".{model_file}.upload"
    with connect_db() as connection:
        existing = connection.execute(
            "SELECT 1 FROM model_versions WHERE version = %s", (version,)
        ).fetchone()
    if existing or destination.exists():
        raise HTTPException(status_code=409, detail=f"Model version {version} already exists")

    digest = hashlib.sha256()
    total_bytes = 0
    saved = False
    try:
        with temporary.open("wb") as output:
            while chunk := await file.read(1024 * 1024):
                total_bytes += len(chunk)
                if total_bytes > MAX_MODEL_BYTES:
                    raise HTTPException(status_code=413, detail="Model exceeds 200 MB")
                digest.update(chunk)
                output.write(chunk)
        if total_bytes == 0:
            raise HTTPException(status_code=400, detail="Uploaded model is empty")

        checksum = digest.hexdigest()
        os.replace(temporary, destination)
        saved = True
        with connect_db() as connection:
            connection.execute(
                """
                INSERT INTO model_versions (
                    version, model_file, sha256, metrics, is_active, activated_at
                ) VALUES (%s, %s, %s, %s, FALSE, NULL)
                """,
                (version, model_file, checksum, json.dumps(parsed_metrics)),
            )
            if activate:
                connection.execute(
                    "UPDATE model_versions SET is_active = FALSE, activated_at = NULL "
                    "WHERE is_active = TRUE"
                )
                connection.execute(
                    "UPDATE model_versions SET is_active = TRUE, activated_at = NOW() "
                    "WHERE version = %s",
                    (version,),
                )
    except HTTPException:
        temporary.unlink(missing_ok=True)
        if saved:
            destination.unlink(missing_ok=True)
        raise
    except (psycopg.Error, OSError) as error:
        temporary.unlink(missing_ok=True)
        if saved:
            destination.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail="Could not save/register model") from error
    finally:
        await file.close()

    return {
        "version": version,
        "model_file": model_file,
        "sha256": checksum,
        "is_active": activate,
    }


@app.put("/models/{version}/activate")
def activate_model(version: str) -> dict[str, str]:
    with connect_db() as connection:
        row = connection.execute(
            "SELECT version FROM model_versions WHERE version = %s", (version,)
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail=f"Model version {version} not found")
        connection.execute(
            "UPDATE model_versions SET is_active = FALSE, activated_at = NULL "
            "WHERE is_active = TRUE"
        )
        connection.execute(
            "UPDATE model_versions SET is_active = TRUE, activated_at = NOW() "
            "WHERE version = %s",
            (version,),
        )
    return {"active_version": version}


@app.get("/models/{version}/download")
def download_model(version: str) -> FileResponse:
    with connect_db() as connection:
        row = connection.execute(
            "SELECT model_file, sha256 FROM model_versions WHERE version = %s", (version,)
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail=f"Model version {version} not found")
    path = MODEL_DIR / row["model_file"]
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Model artifact is missing from storage")
    return FileResponse(
        path,
        media_type="application/octet-stream",
        filename=row["model_file"],
        headers={"X-Model-SHA256": row["sha256"]},
    )
