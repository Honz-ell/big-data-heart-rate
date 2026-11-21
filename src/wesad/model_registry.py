from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
from typing import Any, AsyncIterator

import psycopg
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from psycopg.rows import dict_row

MODEL_DIR = Path(os.getenv("MODEL_STORAGE_DIR", "models")).resolve()
VERSION_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
MAX_MODEL_BYTES = 200 * 1024 * 1024
DEMO_MODE = os.getenv("WESAD_DEMO_MODE", "").strip().lower() in {"1", "true", "yes"}

_DEMO_MODELS: dict[str, dict[str, Any]] = {}


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


def _seed_demo_models() -> None:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    if _DEMO_MODELS:
        return
    now_iso = datetime.now(timezone.utc).isoformat()
    candidates = sorted(MODEL_DIR.glob("v*.joblib"))
    for idx, path in enumerate(candidates):
        version = path.stem
        sha256 = hashlib.sha256(path.read_bytes()).hexdigest()
        metrics: dict[str, Any] = {}
        try:
            import joblib

            bundle = joblib.load(path)
            if "loso_mean_metrics" in bundle:
                metrics["loso_mean_metrics"] = bundle["loso_mean_metrics"]
            if "heldout_metrics" in bundle:
                metrics["heldout_metrics"] = bundle["heldout_metrics"]
            if "excluded_subjects" in bundle:
                metrics["excluded_subjects"] = list(bundle["excluded_subjects"])
        except Exception:
            pass
        is_active = idx == len(candidates) - 1
        _DEMO_MODELS[version] = {
            "version": version,
            "model_file": path.name,
            "sha256": sha256,
            "feature_schema_version": "v1",
            "metrics": metrics,
            "is_active": is_active,
            "created_at": now_iso,
            "activated_at": now_iso if is_active else None,
        }


def ensure_schema() -> None:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    if DEMO_MODE:
        _seed_demo_models()
        return
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


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    ensure_schema()
    yield


app = FastAPI(
    title="WESAD Edge Model Registry",
    version="1.1.0",
    description="Local registry for versioning and distributing Edge models.",
    lifespan=lifespan,
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
    if DEMO_MODE:
        _seed_demo_models()
        return {"status": "ok", "mode": "demo"}
    try:
        with connect_db() as connection:
            connection.execute("SELECT 1")
    except psycopg.Error as error:
        raise HTTPException(status_code=503, detail="PostgreSQL is unavailable") from error
    return {"status": "ok", "mode": "postgres"}


@app.get("/models")
def list_models() -> list[dict[str, Any]]:
    if DEMO_MODE:
        _seed_demo_models()
        return sorted(
            [dict(item) for item in _DEMO_MODELS.values()],
            key=lambda item: str(item["version"]),
            reverse=True,
        )
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
    if DEMO_MODE:
        _seed_demo_models()
        active = next((dict(item) for item in _DEMO_MODELS.values() if item["is_active"]), None)
        if active is None:
            raise HTTPException(status_code=404, detail="No active model is registered")
        active["download_url"] = f"/models/{active['version']}/download"
        return active
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

    if DEMO_MODE:
        _seed_demo_models()
        if version in _DEMO_MODELS:
            raise HTTPException(status_code=409, detail=f"Model version {version} already exists")
    else:
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
        if DEMO_MODE:
            now_iso = datetime.now(timezone.utc).isoformat()
            if activate:
                for item in _DEMO_MODELS.values():
                    item["is_active"] = False
                    item["activated_at"] = None
            _DEMO_MODELS[version] = {
                "version": version,
                "model_file": model_file,
                "sha256": checksum,
                "feature_schema_version": "v1",
                "metrics": parsed_metrics,
                "is_active": activate,
                "created_at": now_iso,
                "activated_at": now_iso if activate else None,
            }
        else:
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
    if DEMO_MODE:
        _seed_demo_models()
        if version not in _DEMO_MODELS:
            raise HTTPException(status_code=404, detail=f"Model version {version} not found")
        now_iso = datetime.now(timezone.utc).isoformat()
        for key, item in _DEMO_MODELS.items():
            item["is_active"] = key == version
            item["activated_at"] = now_iso if key == version else None
        return {"active_version": version}
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
    if DEMO_MODE:
        _seed_demo_models()
        row = _DEMO_MODELS.get(version)
    else:
        with connect_db() as connection:
            row = connection.execute(
                "SELECT model_file, sha256 FROM model_versions WHERE version = %s", (version,)
            ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail=f"Model version {version} not found")
    path = MODEL_DIR / str(row["model_file"])
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Model artifact is missing from storage")
    return FileResponse(
        path,
        media_type="application/octet-stream",
        filename=str(row["model_file"]),
        headers={"X-Model-SHA256": str(row["sha256"])},
    )
