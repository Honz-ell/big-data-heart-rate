from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import psycopg
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from psycopg.rows import dict_row

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_ROOT = Path(os.getenv("WESAD_DATA_ROOT", r"D:\btldll\archive\WESAD"))
RUNTIME_DIR = PROJECT_ROOT / "scripts" / "runtime"
DEFAULT_MODEL = PROJECT_ROOT / "models" / "stress_rf_no_s4_eval.joblib"
REGISTRY_URL = os.getenv("MODEL_REGISTRY_URL", "http://localhost:8000")
BROKER = os.getenv("KAFKA_BROKER", "localhost:9092")
TOPIC = os.getenv("KAFKA_TOPIC", "wearable.sensor.v1")

app = FastAPI(
    title="WESAD Device Manager",
    version="1.0.0",
    description="Start/stop local WESAD replay and Edge inference processes.",
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
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


class StartDeviceRequest(BaseModel):
    subject_id: str = Field(pattern=r"^S\d+$")
    start_offset_seconds: int = Field(ge=0, default=300)
    duration_seconds: int = Field(ge=30, le=600, default=40)
    speed: float = Field(gt=0, le=120, default=60)


sessions: dict[str, dict[str, Any]] = {}
sessions_lock = threading.RLock()


def db_connect() -> psycopg.Connection[Any]:
    return psycopg.connect(
        host=os.getenv("DB_HOST", "localhost"),
        port=int(os.getenv("DB_PORT", "5432")),
        dbname=os.getenv("DB_NAME", "wesad"),
        user=os.getenv("DB_USER", "wesad"),
        password=os.getenv("DB_PASSWORD", "wesad_dev_password"),
        row_factory=dict_row,
        connect_timeout=5,
    )


def process_state(process: subprocess.Popen[bytes] | None) -> str:
    if process is None:
        return "not_started"
    code = process.poll()
    return "running" if code is None else ("completed" if code == 0 else f"failed:{code}")


def read_tail(path: Path | None, lines: int = 14) -> list[str]:
    if path is None or not path.is_file():
        return []
    try:
        return path.read_text(encoding="utf-8", errors="replace").splitlines()[-lines:]
    except OSError:
        return []


def public_session(subject_id: str, session: dict[str, Any]) -> dict[str, Any]:
    def current_state(name: str) -> str:
        if session.get(f"{name}_stopped"):
            return "stopped"
        return process_state(session.get(name))

    return {
        "device_id": f"wearable-{subject_id.lower()}",
        "subject_id": subject_id,
        "scenario_offset_seconds": session["start_offset_seconds"],
        "duration_seconds": session["duration_seconds"],
        "speed": session["speed"],
        "created_at": session["created_at"],
        "producer_status": current_state("producer"),
        "edge_status": current_state("edge"),
        "consumer_group": session["consumer_group"],
        "producer_logs": read_tail(session.get("producer_log")),
        "edge_logs": read_tail(session.get("edge_log")),
    }


def stop_process(process: subprocess.Popen[bytes] | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/subjects")
def list_subjects() -> list[str]:
    if not DATA_ROOT.is_dir():
        raise HTTPException(status_code=503, detail=f"Dataset directory is missing: {DATA_ROOT}")
    return sorted(
        (
            path.name
            for path in DATA_ROOT.iterdir()
            if path.is_dir()
            and path.name.startswith("S")
            and path.name[1:].isdigit()
            and (path / f"{path.name}.pkl").is_file()
        ),
        key=lambda subject: int(subject[1:]),
    )


@app.get("/devices")
def list_devices() -> list[dict[str, Any]]:
    with sessions_lock:
        return [public_session(subject, session) for subject, session in sessions.items()]


@app.post("/devices/start")
def start_device(request: StartDeviceRequest) -> dict[str, Any]:
    subject_id = request.subject_id
    subject_dir = DATA_ROOT / subject_id
    if not (subject_dir / f"{subject_id}.pkl").is_file():
        raise HTTPException(status_code=404, detail=f"WESAD pickle not found for {subject_id}")
    if not DEFAULT_MODEL.is_file():
        raise HTTPException(status_code=503, detail=f"Default model is missing: {DEFAULT_MODEL}")

    with sessions_lock:
        previous = sessions.get(subject_id)
        if previous and (
            process_state(previous.get("producer")) == "running"
            or process_state(previous.get("edge")) == "running"
        ):
            raise HTTPException(status_code=409, detail=f"{subject_id} is already running")

        RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        session_id = uuid.uuid4().hex[:8]
        consumer_group = f"edge-{subject_id.lower()}-{session_id}"
        edge_log = RUNTIME_DIR / f"{subject_id}-{session_id}-edge.log"
        producer_log = RUNTIME_DIR / f"{subject_id}-{session_id}-producer.log"
        python = sys.executable
        edge_command = [
            python, "-u", str(PROJECT_ROOT / "scripts" / "edge_inference.py"),
            "--subject", subject_id,
            "--model", str(DEFAULT_MODEL),
            "--model-registry-url", REGISTRY_URL,
            "--starting-offsets", "latest",
            "--consumer-group", consumer_group,
            "--broker", BROKER,
            "--topic", TOPIC,
            "--store-postgres",
        ]
        producer_command = [
            python, "-u", str(PROJECT_ROOT / "scripts" / "produce_e4.py"),
            "--data", str(DATA_ROOT),
            "--subject", subject_id,
            "--source", "pickle",
            "--speed", str(request.speed),
            "--start-offset-seconds", str(request.start_offset_seconds),
            "--duration-seconds", str(request.duration_seconds),
            "--limit", "0",
            "--broker", BROKER,
            "--topic", TOPIC,
        ]
        edge_process: subprocess.Popen[bytes] | None = None
        child_env = os.environ.copy()
        child_env["PYTHONUTF8"] = "1"
        try:
            with edge_log.open("w", encoding="utf-8") as edge_output:
                edge_process = subprocess.Popen(
                    edge_command,
                    cwd=PROJECT_ROOT,
                    stdin=subprocess.DEVNULL,
                    stdout=edge_output,
                    stderr=subprocess.STDOUT,
                    env=child_env,
                )

            ready_deadline = time.monotonic() + 15
            while time.monotonic() < ready_deadline:
                if edge_process.poll() is not None:
                    raise RuntimeError(f"Edge exited early; inspect {edge_log.name}")
                if "edge simulator" in "\n".join(read_tail(edge_log, 30)).lower():
                    break
                time.sleep(0.25)
            else:
                raise RuntimeError(f"Edge did not become ready; inspect {edge_log.name}")

            with producer_log.open("w", encoding="utf-8") as producer_output:
                producer_process = subprocess.Popen(
                    producer_command,
                    cwd=PROJECT_ROOT,
                    stdin=subprocess.DEVNULL,
                    stdout=producer_output,
                    stderr=subprocess.STDOUT,
                    env=child_env,
                )
        except (OSError, RuntimeError) as error:
            stop_process(edge_process)
            raise HTTPException(status_code=503, detail=str(error)) from error

        session = {
            "producer": producer_process,
            "edge": edge_process,
            "producer_stopped": False,
            "edge_stopped": False,
            "producer_log": producer_log,
            "edge_log": edge_log,
            "start_offset_seconds": request.start_offset_seconds,
            "duration_seconds": request.duration_seconds,
            "speed": request.speed,
            "consumer_group": consumer_group,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        sessions[subject_id] = session
        return public_session(subject_id, session)


@app.post("/devices/{subject_id}/stop")
def stop_device(subject_id: str) -> dict[str, Any]:
    with sessions_lock:
        session = sessions.get(subject_id)
        if session is None:
            raise HTTPException(status_code=404, detail=f"No session for {subject_id}")
        stop_process(session.get("producer"))
        stop_process(session.get("edge"))
        session["producer_stopped"] = True
        session["edge_stopped"] = True
        return public_session(subject_id, session)


@app.get("/devices/{subject_id}/predictions")
def device_predictions(subject_id: str, limit: int = 20) -> list[dict[str, Any]]:
    if not subject_id.startswith("S") or not subject_id[1:].isdigit():
        raise HTTPException(status_code=422, detail="Invalid subject ID")
    if not 1 <= limit <= 100:
        raise HTTPException(status_code=422, detail="limit must be between 1 and 100")
    try:
        with db_connect() as connection:
            rows = connection.execute(
                """
                SELECT subject_id, window_start, window_end, prediction,
                       model_score_stress, model_file, model_version, sample_counts
                FROM stress_predictions
                WHERE subject_id = %s
                ORDER BY window_start DESC
                LIMIT %s
                """,
                (subject_id, limit),
            ).fetchall()
    except psycopg.Error as error:
        raise HTTPException(status_code=503, detail="Could not read prediction history") from error
    return rows


@app.get("/devices/{subject_id}/logs")
def device_logs(subject_id: str) -> dict[str, list[str]]:
    with sessions_lock:
        session = sessions.get(subject_id)
        if session is None:
            raise HTTPException(status_code=404, detail=f"No session for {subject_id}")
        return {
            "producer": read_tail(session.get("producer_log"), 30),
            "edge": read_tail(session.get("edge_log"), 30),
        }


@app.on_event("shutdown")
def stop_children_on_shutdown() -> None:
    with sessions_lock:
        for session in sessions.values():
            stop_process(session.get("producer"))
            stop_process(session.get("edge"))
