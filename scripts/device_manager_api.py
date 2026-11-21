from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from typing import Any, AsyncIterator
import uuid

import joblib
import psycopg
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from psycopg.rows import dict_row
from pydantic import BaseModel, Field
import requests

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT / "src"))

from wesad.demo_simulator import SCENARIO_CATALOG, generate_scenario_windows  # noqa: E402
from wesad.vitals import classify_activity  # noqa: E402

DATA_ROOT = Path(os.getenv("WESAD_DATA_ROOT", r"D:\btldll\archive\WESAD"))
RUNTIME_DIR = PROJECT_ROOT / "scripts" / "runtime"
DEFAULT_MODEL = PROJECT_ROOT / "models" / "stress_rf_no_s4_eval.joblib"
FALLBACK_MODEL = PROJECT_ROOT / "models" / "stress_rf.joblib"
REGISTRY_URL = os.getenv("MODEL_REGISTRY_URL", "http://localhost:8000")
BROKER = os.getenv("KAFKA_BROKER", "localhost:9092")
TOPIC = os.getenv("KAFKA_TOPIC", "wearable.sensor.v1")
DEMO_MODE = os.getenv("WESAD_DEMO_MODE", "").strip().lower() in {"1", "true", "yes"}
DEMO_SUBJECTS = ["S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S13", "S14", "S15", "S16", "S17"]


class StartDeviceRequest(BaseModel):
    subject_id: str = Field(pattern=r"^S\d+$")
    start_offset_seconds: int = Field(ge=0, default=3690)
    duration_seconds: int = Field(ge=30, le=1800, default=180)
    speed: float = Field(gt=0, le=120, default=30)
    scenario_id: str | None = Field(default=None)
    replace_running: bool = Field(default=True)


class FeedbackRequest(BaseModel):
    subject_id: str = Field(pattern=r"^S\d+$")
    window_start: str
    verdict: str = Field(pattern=r"^(ACCURATE|FALSE_ALARM)$")
    note: str = Field(default="", max_length=240)


sessions: dict[str, dict[str, Any]] = {}
sessions_lock = threading.RLock()

# Persistent PostgreSQL connection to avoid per-poll TCP/auth & DDL lock overhead
_db_lock = threading.RLock()
_shared_conn: psycopg.Connection[Any] | None = None
_schema_checked = False

# Demo / sandbox in-memory stores
demo_predictions: dict[str, list[dict[str, Any]]] = {}
demo_spark_rows: dict[str, list[dict[str, Any]]] = {}
demo_feedback: dict[tuple[str, str], dict[str, Any]] = {}
_cached_rf_bundle: dict[str, Any] | None = None


def _load_local_rf() -> tuple[Any, str, str | None]:
    global _cached_rf_bundle
    model_path = DEFAULT_MODEL if DEFAULT_MODEL.is_file() else FALLBACK_MODEL
    if _cached_rf_bundle is None:
        _cached_rf_bundle = joblib.load(model_path)
    active_version: str | None = _cached_rf_bundle.get("model_version") or "v1.0.0"
    active_file = model_path.name
    try:
        resp = requests.get(f"{REGISTRY_URL.rstrip('/')}/models/active", timeout=1.0)
        if resp.status_code == 200:
            payload = resp.json()
            active_version = str(payload.get("version") or active_version)
            active_file = str(payload.get("model_file") or active_file)
            candidate = PROJECT_ROOT / "models" / active_file
            if candidate.is_file():
                bundle = joblib.load(candidate)
                return bundle["model"], active_file, active_version
    except Exception:
        pass
    return _cached_rf_bundle["model"], active_file, active_version


def _infer_scenario_id(offset_seconds: int, explicit_id: str | None) -> str:
    if explicit_id and any(item["id"] == explicit_id for item in SCENARIO_CATALOG):
        return explicit_id
    if offset_seconds <= 900:
        return "baseline_calm"
    if 3400 <= offset_seconds <= 3630 or 1800 <= offset_seconds <= 2600:
        return "physical_activity_check"
    if offset_seconds >= 4050:
        return "stress_to_recovery"
    return "tsst_acute_stress"


def _seed_initial_demo_data() -> None:
    if not DEMO_MODE or "S4" in demo_predictions:
        return
    try:
        model, model_file, model_version = _load_local_rf()
        spark_rows, pred_rows = generate_scenario_windows(
            scenario_id="stress_to_recovery",
            subject_id="S4",
            model=model,
            model_file=model_file,
            model_version=model_version,
            duration_seconds=240,
        )
        demo_spark_rows["S4"] = spark_rows
        demo_predictions["S4"] = pred_rows
    except Exception:
        pass


def _open_new_conn() -> psycopg.Connection[Any]:
    return psycopg.connect(
        host=os.getenv("DB_HOST", "localhost"),
        port=int(os.getenv("DB_PORT", "5432")),
        dbname=os.getenv("DB_NAME", "wesad"),
        user=os.getenv("DB_USER", "wesad"),
        password=os.getenv("DB_PASSWORD", "wesad_dev_password"),
        row_factory=dict_row,
        autocommit=True,
        connect_timeout=3,
    )


def _get_db() -> psycopg.Connection[Any]:
    """Return a fast reusable PostgreSQL connection; run schema check only once."""
    global _shared_conn, _schema_checked
    if _shared_conn is None or _shared_conn.closed or _shared_conn.broken:
        _shared_conn = _open_new_conn()
    if not _schema_checked:
        _shared_conn.execute(
            "ALTER TABLE stress_predictions "
            "ADD COLUMN IF NOT EXISTS vitals JSONB NOT NULL DEFAULT '{}'::jsonb"
        )
        _shared_conn.execute(
            """
            CREATE TABLE IF NOT EXISTS prediction_feedback (
                subject_id TEXT NOT NULL,
                window_start TIMESTAMPTZ NOT NULL,
                verdict TEXT NOT NULL CHECK (verdict IN ('ACCURATE', 'FALSE_ALARM')),
                note TEXT NOT NULL DEFAULT '',
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (subject_id, window_start)
            )
            """
        )
        _schema_checked = True
    return _shared_conn


def _reset_db() -> None:
    global _shared_conn
    if _shared_conn is not None:
        try:
            _shared_conn.close()
        except Exception:
            pass
        _shared_conn = None


def process_state(process: subprocess.Popen[bytes] | None) -> str:
    if process is None:
        return "not_started"
    code = process.poll()
    return "running" if code is None else ("completed" if code == 0 else f"failed:{code}")


def read_tail(path: Path | None, lines: int = 14) -> list[str]:
    if path is None or not path.is_file():
        return []
    try:
        with path.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - 6144), os.SEEK_SET)
            tail_bytes = handle.read()
        return tail_bytes.decode("utf-8", errors="replace").splitlines()[-lines:]
    except OSError:
        return []


def public_session(subject_id: str, session: dict[str, Any]) -> dict[str, Any]:
    if session.get("is_demo"):
        return {
            "device_id": f"wearable-{subject_id.lower()}",
            "subject_id": subject_id,
            "scenario_id": session.get("scenario_id"),
            "scenario_offset_seconds": session["start_offset_seconds"],
            "duration_seconds": session["duration_seconds"],
            "speed": session["speed"],
            "created_at": session["created_at"],
            "producer_status": session.get("demo_producer_status", "completed"),
            "edge_status": session.get("demo_edge_status", "completed"),
            "consumer_group": session["consumer_group"],
            "mode": "demo_replay",
            "producer_logs": list(session.get("demo_producer_logs", []))[-14:],
            "edge_logs": list(session.get("demo_edge_logs", []))[-14:],
        }

    def current_state(name: str) -> str:
        if session.get(f"{name}_stopped"):
            return "stopped"
        override = session.get(f"{name}_override")
        proc = session.get(name)
        if proc is None and override:
            return str(override)
        return process_state(proc)

    return {
        "device_id": f"wearable-{subject_id.lower()}",
        "subject_id": subject_id,
        "scenario_id": session.get("scenario_id"),
        "scenario_offset_seconds": session["start_offset_seconds"],
        "duration_seconds": session["duration_seconds"],
        "speed": session["speed"],
        "created_at": session["created_at"],
        "producer_status": current_state("producer"),
        "edge_status": current_state("edge"),
        "consumer_group": session["consumer_group"],
        "mode": "live_stack",
        "producer_logs": read_tail(session.get("producer_log")),
        "edge_logs": read_tail(session.get("edge_log")),
    }


def stop_process(process: subprocess.Popen[bytes] | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=2)


def stop_all_sessions() -> None:
    with sessions_lock:
        for session in sessions.values():
            session["cancelled"] = True
            session["demo_cancelled"] = True
            stop_process(session.get("producer"))
            stop_process(session.get("edge"))
    with _db_lock:
        _reset_db()


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    _seed_initial_demo_data()
    yield
    stop_all_sessions()


app = FastAPI(
    title="WESAD Device Manager & Health Telemetry API",
    version="1.2.0",
    description="Start/stop WESAD streams and serve dual-speed Spark (10s) + Edge AI (30s) physiological timelines.",
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
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "mode": "demo_replay" if DEMO_MODE else "live_stack",
        "dataset_available": DATA_ROOT.is_dir(),
    }


@app.get("/scenarios")
def list_scenarios() -> list[dict[str, Any]]:
    return SCENARIO_CATALOG


@app.get("/subjects")
def list_subjects() -> list[str]:
    if DATA_ROOT.is_dir():
        found = sorted(
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
        if found:
            return found
    if DEMO_MODE:
        return DEMO_SUBJECTS
    raise HTTPException(status_code=503, detail=f"Dataset directory is missing: {DATA_ROOT}")


@app.get("/devices")
def list_devices() -> list[dict[str, Any]]:
    with sessions_lock:
        return [public_session(subject, session) for subject, session in sessions.items()]


def _start_demo_session(request: StartDeviceRequest, scenario_id: str) -> dict[str, Any]:
    subject_id = request.subject_id
    session_id = uuid.uuid4().hex[:8]
    consumer_group = f"edge-{subject_id.lower()}-{session_id}"
    model, model_file, model_version = _load_local_rf()
    now_dt = datetime.now(timezone.utc)
    spark_rows, pred_rows = generate_scenario_windows(
        scenario_id=scenario_id,
        subject_id=subject_id,
        model=model,
        model_file=model_file,
        model_version=model_version,
        duration_seconds=request.duration_seconds,
        base_time=now_dt,
    )

    session: dict[str, Any] = {
        "is_demo": True,
        "demo_cancelled": False,
        "scenario_id": scenario_id,
        "start_offset_seconds": request.start_offset_seconds,
        "duration_seconds": request.duration_seconds,
        "speed": request.speed,
        "consumer_group": consumer_group,
        "created_at": now_dt.isoformat(),
        "started_at_dt": now_dt,
        "demo_producer_status": "running",
        "demo_edge_status": "running",
        "demo_producer_logs": [
            f"[Sandbox Replay] Đang phát {subject_id} kịch bản={scenario_id}, "
            f"offset={request.start_offset_seconds}s, duration={request.duration_seconds}s, speed={request.speed}x"
        ],
        "demo_edge_logs": [
            f"Model Edge đang kích hoạt: version={model_version or 'local'}, file={model_file}",
            f"Edge simulator {subject_id} đang phân tích cửa sổ 30s kết hợp luồng Spark 10s...",
        ],
    }

    with sessions_lock:
        old = sessions.get(subject_id)
        if old:
            old["demo_cancelled"] = True
        sessions[subject_id] = session
        demo_spark_rows[subject_id] = []
        demo_predictions[subject_id] = []

    def worker() -> None:
        step_delay = max(0.22, min(0.80, 10.0 / max(10.0, float(request.speed))))
        spark_per_10s = 5
        total_10s_buckets = len(pred_rows) * 3
        sent_samples = 0

        for bucket_idx in range(total_10s_buckets):
            if session.get("demo_cancelled"):
                session["demo_producer_status"] = "stopped"
                session["demo_edge_status"] = "stopped"
                return
            time.sleep(step_delay)
            slice_rows = spark_rows[bucket_idx * spark_per_10s : (bucket_idx + 1) * spark_per_10s]
            with sessions_lock:
                demo_spark_rows.setdefault(subject_id, []).extend(slice_rows)
                sent_samples += 1050
                if slice_rows:
                    ts_txt = slice_rows[0]["window_end_utc"]
                    session["demo_producer_logs"].append(
                        f"Đã gửi {sent_samples:,} mẫu · Spark 10s batch #{slice_rows[0]['spark_batch_id']} @ {ts_txt}"
                    )

                if (bucket_idx + 1) % 3 == 0:
                    pred = pred_rows[bucket_idx // 3]
                    _, cur_file, cur_ver = _load_local_rf()
                    pred = {**pred, "model_file": cur_file, "model_version": cur_ver}
                    demo_predictions.setdefault(subject_id, []).append(pred)
                    vit = pred["vitals"]
                    session["demo_edge_logs"].append(
                        f"{subject_id} | {pred['window_start']} – {pred['window_end']} | "
                        f"{pred['prediction']} (RF={pred['model_score_stress']:.3f}, Load={vit['stress_load']}/100) | "
                        f"HR={vit['hr_bpm']} bpm | HRV={vit['hrv_rmssd_ms']} ms | EDA={vit['eda_mean_us']:.2f} uS"
                    )

        with sessions_lock:
            if not session.get("demo_cancelled"):
                session["demo_producer_status"] = "completed"
                session["demo_edge_status"] = "completed"
                session["demo_producer_logs"].append(
                    f"Hoàn tất phát {sent_samples:,} mẫu ({len(pred_rows)} cửa sổ AI 30s · {total_10s_buckets} cửa sổ Spark 10s)."
                )

    threading.Thread(target=worker, daemon=True).start()
    return public_session(subject_id, session)


@app.post("/devices/start")
def start_device(request: StartDeviceRequest) -> dict[str, Any]:
    subject_id = request.subject_id
    scenario_id = _infer_scenario_id(request.start_offset_seconds, request.scenario_id)

    subject_dir = DATA_ROOT / subject_id
    has_real_pickle = (subject_dir / f"{subject_id}.pkl").is_file()
    if DEMO_MODE or not has_real_pickle:
        if not DEMO_MODE and not DATA_ROOT.is_dir():
            raise HTTPException(status_code=503, detail=f"Dataset directory is missing: {DATA_ROOT}")
        if not DEMO_MODE and not has_real_pickle:
            raise HTTPException(status_code=404, detail=f"WESAD pickle not found for {subject_id}")
        return _start_demo_session(request, scenario_id)

    if not DEFAULT_MODEL.is_file():
        raise HTTPException(status_code=503, detail=f"Default model is missing: {DEFAULT_MODEL}")

    prev_procs: list[subprocess.Popen[bytes] | None] = []
    now_dt = datetime.now(timezone.utc)
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    session_id = uuid.uuid4().hex[:8]
    consumer_group = f"edge-{subject_id.lower()}-{session_id}"
    edge_log = RUNTIME_DIR / f"{subject_id}-{session_id}-edge.log"
    producer_log = RUNTIME_DIR / f"{subject_id}-{session_id}-producer.log"

    with sessions_lock:
        previous = sessions.get(subject_id)
        if previous:
            prod_running = (
                previous.get("producer_override") == "starting"
                or process_state(previous.get("producer")) == "running"
            )
            if prod_running and not request.replace_running:
                raise HTTPException(status_code=409, detail=f"{subject_id} is already running")
            previous["cancelled"] = True
            previous["producer_stopped"] = True
            previous["edge_stopped"] = True
            prev_procs.extend([previous.get("producer"), previous.get("edge")])

        session: dict[str, Any] = {
            "is_demo": False,
            "cancelled": False,
            "scenario_id": scenario_id,
            "producer": None,
            "edge": None,
            "producer_override": "starting",
            "edge_override": "starting",
            "producer_stopped": False,
            "edge_stopped": False,
            "producer_log": producer_log,
            "edge_log": edge_log,
            "start_offset_seconds": request.start_offset_seconds,
            "duration_seconds": request.duration_seconds,
            "speed": request.speed,
            "consumer_group": consumer_group,
            "created_at": now_dt.isoformat(),
            "started_at_dt": now_dt,
        }
        sessions[subject_id] = session

    # Launch Edge + Producer asynchronously so HTTP response returns in <15ms without blocking UI
    def launch_worker() -> None:
        for proc in prev_procs:
            stop_process(proc)
        if session.get("cancelled"):
            return

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
        child_env = os.environ.copy()
        child_env["PYTHONUTF8"] = "1"
        edge_proc: subprocess.Popen[bytes] | None = None
        try:
            with edge_log.open("w", encoding="utf-8") as edge_output:
                edge_proc = subprocess.Popen(
                    edge_command,
                    cwd=PROJECT_ROOT,
                    stdin=subprocess.DEVNULL,
                    stdout=edge_output,
                    stderr=subprocess.STDOUT,
                    env=child_env,
                )
            with sessions_lock:
                session["edge"] = edge_proc
                session["edge_override"] = None

            ready_deadline = time.monotonic() + 20.0
            while time.monotonic() < ready_deadline:
                if session.get("cancelled"):
                    stop_process(edge_proc)
                    return
                if edge_proc.poll() is not None:
                    session["producer_override"] = "failed:edge_exited"
                    return
                if "edge simulator" in "\n".join(read_tail(edge_log, 25)).lower():
                    break
                time.sleep(0.18)
            else:
                stop_process(edge_proc)
                session["producer_override"] = "failed:edge_timeout"
                return

            if session.get("cancelled"):
                stop_process(edge_proc)
                return

            with producer_log.open("w", encoding="utf-8") as producer_output:
                prod_proc = subprocess.Popen(
                    producer_command,
                    cwd=PROJECT_ROOT,
                    stdin=subprocess.DEVNULL,
                    stdout=producer_output,
                    stderr=subprocess.STDOUT,
                    env=child_env,
                )
            with sessions_lock:
                session["producer"] = prod_proc
                session["producer_override"] = None
                if session.get("cancelled"):
                    stop_process(prod_proc)
                    stop_process(edge_proc)
        except OSError:
            stop_process(edge_proc)
            with sessions_lock:
                session["producer_override"] = "failed:spawn"
                session["edge_override"] = "failed:spawn"

    threading.Thread(target=launch_worker, daemon=True).start()
    return public_session(subject_id, session)


@app.post("/devices/{subject_id}/stop")
def stop_device(subject_id: str) -> dict[str, Any]:
    with sessions_lock:
        session = sessions.get(subject_id)
        if session is None:
            raise HTTPException(status_code=404, detail=f"No session for {subject_id}")
        session["cancelled"] = True
        if session.get("is_demo"):
            session["demo_cancelled"] = True
            session["demo_producer_status"] = "stopped"
            session["demo_edge_status"] = "stopped"
            return public_session(subject_id, session)
        proc_p = session.get("producer")
        proc_e = session.get("edge")
        session["producer_stopped"] = True
        session["edge_stopped"] = True

    stop_process(proc_p)
    stop_process(proc_e)
    with sessions_lock:
        return public_session(subject_id, sessions[subject_id])


@app.delete("/devices/{subject_id}/history")
def clear_subject_history(subject_id: str) -> dict[str, Any]:
    if not subject_id.startswith("S") or not subject_id[1:].isdigit():
        raise HTTPException(status_code=422, detail="Invalid subject ID")
    with sessions_lock:
        demo_predictions.pop(subject_id, None)
        demo_spark_rows.pop(subject_id, None)
        if subject_id in sessions:
            sessions[subject_id]["started_at_dt"] = datetime.now(timezone.utc)
    if DEMO_MODE:
        return {"cleared": True, "subject_id": subject_id}

    try:
        with _db_lock:
            conn = _get_db()
            conn.execute("DELETE FROM stress_predictions WHERE subject_id = %s", (subject_id,))
            conn.execute("DELETE FROM sensor_window_aggregates WHERE subject_id = %s", (subject_id,))
            conn.execute("DELETE FROM prediction_feedback WHERE subject_id = %s", (subject_id,))
    except psycopg.Error as error:
        _reset_db()
        raise HTTPException(status_code=503, detail="Could not clear PostgreSQL history") from error
    return {"cleared": True, "subject_id": subject_id}


def _iso_utc(val: Any) -> str:
    if isinstance(val, datetime):
        return val.astimezone(timezone.utc).isoformat()
    return str(val)


def _to_dt(val: Any) -> datetime:
    if isinstance(val, datetime):
        return val.astimezone(timezone.utc)
    return datetime.fromisoformat(str(val).replace("Z", "+00:00")).astimezone(timezone.utc)


def _extract_latest_contiguous_segment(
    rows_newest_created_first: list[dict[str, Any]],
    max_windows: int,
) -> list[dict[str, Any]]:
    """Isolate the most recently generated contiguous scenario segment so old runs at different offsets never squish the chart."""
    if not rows_newest_created_first:
        return []
    anchor = rows_newest_created_first[0]
    anchor_created = _to_dt(anchor.get("created_at") or anchor["window_start"])

    # Keep rows created in the same recent batch/run (within 10 minutes of newest row) and contiguous in recording time
    recent_pool = [
        r
        for r in rows_newest_created_first
        if abs((anchor_created - _to_dt(r.get("created_at") or r["window_start"])).total_seconds()) <= 600
    ]
    by_window = sorted(recent_pool, key=lambda r: _to_dt(r["window_start"]))

    # Partition into contiguous segments (gap between consecutive window_start <= 90s)
    segments: list[list[dict[str, Any]]] = []
    for row in by_window:
        w_dt = _to_dt(row["window_start"])
        if not segments:
            segments.append([row])
            continue
        prev_dt = _to_dt(segments[-1][-1]["window_start"])
        if (w_dt - prev_dt).total_seconds() <= 95:
            segments[-1].append(row)
        else:
            segments.append([row])

    # Pick the segment containing our newest `anchor` row
    anchor_ws = _iso_utc(anchor["window_start"])
    chosen = next(
        (seg for seg in segments if any(_iso_utc(item["window_start"]) == anchor_ws for item in seg)),
        segments[-1],
    )
    return chosen[-max_windows:]


def _pivot_spark_rows(raw_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    buckets: dict[str, dict[str, Any]] = {}
    for row in raw_rows:
        w_start = _iso_utc(row["window_start_utc"])
        w_end = _iso_utc(row["window_end_utc"])
        entry = buckets.setdefault(
            w_start,
            {
                "window_start_utc": w_start,
                "window_end_utc": w_end,
                "hr_bpm": None,
                "eda_us": None,
                "temp_c": None,
                "acc_mean": None,
                "acc_range": None,
                "bvp_range": None,
                "sample_count_total": 0,
                "spark_batch_id": int(row.get("spark_batch_id") or 0),
            },
        )
        sensor = str(row["sensor"]).upper()
        mean_v = float(row["mean_value"])
        min_v = float(row["min_value"])
        max_v = float(row["max_value"])
        entry["sample_count_total"] += int(row.get("sample_count") or 0)
        entry["spark_batch_id"] = max(entry["spark_batch_id"], int(row.get("spark_batch_id") or 0))
        if sensor == "HR":
            entry["hr_bpm"] = round(mean_v, 1)
        elif sensor == "EDA":
            entry["eda_us"] = round(mean_v, 3)
        elif sensor == "TEMP":
            entry["temp_c"] = round(mean_v, 2)
        elif sensor == "ACC":
            entry["acc_mean"] = round(mean_v, 2)
            entry["acc_range"] = round(max_v - min_v, 2)
        elif sensor == "BVP":
            entry["bvp_range"] = round(max_v - min_v, 2)
    return [buckets[k] for k in sorted(buckets.keys())]


def _merge_subwindow_fallbacks(
    preds_chrono: list[dict[str, Any]],
    spark_points: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Ensure every 30s prediction window has 3 x 10s vital points even if Spark micro-batch is still in flight."""
    by_start: dict[str, dict[str, Any]] = {pt["window_start_utc"]: dict(pt) for pt in spark_points}
    for pred in preds_chrono:
        base_dt = _to_dt(pred["window_start"])
        vit = pred.get("vitals") or {}
        subs = vit.get("sub_windows_10s")
        if isinstance(subs, list) and len(subs) == 3:
            for idx, sub in enumerate(subs):
                s_dt = base_dt + timedelta(seconds=idx * 10)
                e_dt = s_dt + timedelta(seconds=10)
                key = s_dt.isoformat()
                if key not in by_start:
                    by_start[key] = {
                        "window_start_utc": key,
                        "window_end_utc": e_dt.isoformat(),
                        "hr_bpm": sub.get("hr_bpm"),
                        "eda_us": sub.get("eda_us"),
                        "temp_c": sub.get("temp_c"),
                        "acc_mean": sub.get("acc_mean"),
                        "acc_range": sub.get("acc_range"),
                        "bvp_range": None,
                        "sample_count_total": int(sub.get("sample_count_total") or 1040),
                        "spark_batch_id": 0,
                    }
                else:
                    existing = by_start[key]
                    if existing["hr_bpm"] is None and sub.get("hr_bpm") is not None:
                        existing["hr_bpm"] = sub["hr_bpm"]
                    if existing["eda_us"] is None and sub.get("eda_us") is not None:
                        existing["eda_us"] = sub["eda_us"]
                    if existing["temp_c"] is None and sub.get("temp_c") is not None:
                        existing["temp_c"] = sub["temp_c"]
        else:
            # Synthesize 3 even 10s slots from 30s summary vitals for legacy rows
            for idx in range(3):
                s_dt = base_dt + timedelta(seconds=idx * 10)
                e_dt = s_dt + timedelta(seconds=10)
                key = s_dt.isoformat()
                if key not in by_start:
                    by_start[key] = {
                        "window_start_utc": key,
                        "window_end_utc": e_dt.isoformat(),
                        "hr_bpm": vit.get("hr_bpm"),
                        "eda_us": vit.get("eda_mean_us"),
                        "temp_c": vit.get("temp_mean_c"),
                        "acc_mean": None,
                        "acc_range": None,
                        "bvp_range": None,
                        "sample_count_total": 1040,
                        "spark_batch_id": 0,
                    }
    return [by_start[k] for k in sorted(by_start.keys())]


def _backfill_legacy_vitals(
    pred: dict[str, Any], spark_points: list[dict[str, Any]]
) -> dict[str, Any]:
    existing = pred.get("vitals")
    if isinstance(existing, dict) and existing.get("stress_load") is not None:
        return existing

    w_start = _iso_utc(pred["window_start"])
    w_end = _iso_utc(pred["window_end"])
    overlapping = [
        pt
        for pt in spark_points
        if pt["window_start_utc"] >= w_start and pt["window_end_utc"] <= w_end
    ]
    hrs = [float(pt["hr_bpm"]) for pt in overlapping if pt["hr_bpm"] is not None]
    edas = [float(pt["eda_us"]) for pt in overlapping if pt["eda_us"] is not None]
    temps = [float(pt["temp_c"]) for pt in overlapping if pt["temp_c"] is not None]
    acc_ranges = [float(pt["acc_range"]) for pt in overlapping if pt["acc_range"] is not None]

    hr_bpm = round(sum(hrs) / len(hrs), 1) if hrs else None
    eda_us = round(sum(edas) / len(edas), 3) if edas else None
    temp_c = round(sum(temps) / len(temps), 2) if temps else None
    est_acc_std = (sum(acc_ranges) / len(acc_ranges)) / 4.5 if acc_ranges else 0.7
    activity_state, acc_g = classify_activity(est_acc_std)

    rf_score = float(pred["model_score_stress"])
    stress_load = int(round(min(98.0, max(6.0, rf_score * 86.0 + (10.0 if rf_score >= 0.5 else 4.0)))))
    reason_label = (
        "Tổ hợp tín hiệu cổ tay vượt ngưỡng căng thẳng"
        if pred["prediction"] == "STRESS"
        else "Các tín hiệu sinh lý trong ngưỡng ổn định"
    )
    return {
        "hr_bpm": hr_bpm,
        "baseline_hr_bpm": 73.0,
        "hr_delta_bpm": round(hr_bpm - 73.0, 1) if hr_bpm is not None else None,
        "hrv_rmssd_ms": None,
        "eda_mean_us": eda_us,
        "eda_std_us": None,
        "temp_mean_c": temp_c,
        "acc_activity_g": acc_g,
        "activity_state": activity_state,
        "heart_anomaly": "NONE",
        "stress_load": stress_load,
        "signal_quality": 1.0,
        "reason_codes": [
            {
                "code": "RF_SCORE",
                "severity": "high" if pred["prediction"] == "STRESS" else "low",
                "label": reason_label,
                "detail": f"Điểm xác suất mô hình Random Forest đạt {rf_score:.1%}.",
            }
        ],
    }


def _build_clinical_summary(
    chronological_preds: list[dict[str, Any]],
    spark_points: list[dict[str, Any]],
    is_warming_up: bool = False,
) -> dict[str, Any]:
    if not chronological_preds and not spark_points:
        return {
            "status": "NO_DATA",
            "headline": (
                "Đang khởi tạo & thu thập cửa sổ cảm biến đầu tiên..."
                if is_warming_up
                else "Chưa có dữ liệu phiên đo cho thiết bị này"
            ),
            "recommendation": (
                "Producer đang phát mẫu Empatica E4 vào Kafka; kết quả 10s/30s sẽ hiển thị ngay sau vài giây."
                if is_warming_up
                else "Chọn một kịch bản mẫu ở thanh trên (ví dụ: Áp lực thuyết trình TSST) để bắt đầu phát luồng cảm biến."
            ),
            "latest_hr_bpm": None,
            "baseline_hr_bpm": None,
            "hr_delta_bpm": None,
            "latest_hrv_rmssd_ms": None,
            "latest_eda_us": None,
            "latest_temp_c": None,
            "latest_stress_load": None,
            "latest_rf_score": None,
            "activity_state": "RESTING",
            "heart_anomaly": "NONE",
            "consecutive_stress_windows": 0,
            "consecutive_stress_seconds": 0,
            "stress_ratio_pct": 0.0,
            "anomaly_windows_count": 0,
            "recovery_seconds": None,
            "spark_windows_count": 0,
            "latest_spark_batch_id": None,
        }

    latest_pred = chronological_preds[-1] if chronological_preds else None
    latest_vit = latest_pred["vitals"] if latest_pred else {}
    latest_spark = spark_points[-1] if spark_points else {}

    latest_hr = (
        latest_spark.get("hr_bpm")
        if latest_spark.get("hr_bpm") is not None
        else latest_vit.get("hr_bpm")
    )
    baseline_hr = latest_vit.get("baseline_hr_bpm") or 73.0
    hr_delta = round(float(latest_hr) - float(baseline_hr), 1) if latest_hr is not None else None
    latest_eda = (
        latest_spark.get("eda_us")
        if latest_spark.get("eda_us") is not None
        else latest_vit.get("eda_mean_us")
    )
    latest_temp = (
        latest_spark.get("temp_c")
        if latest_spark.get("temp_c") is not None
        else latest_vit.get("temp_mean_c")
    )

    streak = 0
    for item in reversed(chronological_preds):
        if item["prediction"] == "STRESS":
            streak += 1
        else:
            break

    total_preds = len(chronological_preds)
    stress_total = sum(1 for item in chronological_preds if item["prediction"] == "STRESS")
    stress_ratio_pct = round((stress_total / total_preds) * 100.0, 1) if total_preds else 0.0

    anomaly_count = sum(
        1
        for item in chronological_preds
        if item["vitals"].get("heart_anomaly") in {"TACHYCARDIA_AT_REST", "LOW_HRV_STRAIN", "BRADYCARDIA"}
    )

    recovery_seconds: int | None = None
    last_stress_idx: int | None = None
    for idx, item in enumerate(chronological_preds):
        if item["prediction"] == "STRESS":
            last_stress_idx = idx
    if last_stress_idx is not None and last_stress_idx < total_preds - 1:
        stress_end_dt = _to_dt(chronological_preds[last_stress_idx]["window_end"])
        calm_item = next(
            (
                chronological_preds[j]
                for j in range(last_stress_idx + 1, total_preds)
                if chronological_preds[j]["prediction"] == "NON_STRESS"
                and int(chronological_preds[j]["vitals"].get("stress_load") or 50) <= 42
            ),
            chronological_preds[-1],
        )
        calm_end_dt = _to_dt(calm_item["window_end"])
        diff_sec = int((calm_end_dt - stress_end_dt).total_seconds())
        if 10 <= diff_sec <= 900:
            recovery_seconds = max(30, diff_sec)

    activity_state = str(latest_vit.get("activity_state") or "RESTING")
    heart_anomaly = str(latest_vit.get("heart_anomaly") or "NONE")

    if activity_state == "HIGH_ACTIVITY":
        status = "PHYSICAL_ACTIVITY"
        headline = "Đang vận động thể chất — Nhịp tim tăng sinh lý tự nhiên"
        recommendation = (
            "Gia tốc cổ tay ghi nhận vận động liên tục. Hệ thống tự động loại trừ cảnh báo stress giả; "
            "hãy duy trì nhịp thở đều và bổ sung nước sau khi vận động."
        )
    elif streak >= 3 or (streak >= 2 and heart_anomaly == "TACHYCARDIA_AT_REST"):
        status = "SUSTAINED_STRESS"
        headline = f"Cảnh báo căng thẳng kéo dài ({streak * 30} giây liên tục)"
        recommendation = (
            "Nhịp tim lúc nghỉ tăng cao kèm giảm HRV và tăng dẫn điện da qua nhiều cửa sổ liên tiếp. "
            "Khuyến nghị: tạm rời màn hình 2 phút, thả lỏng vai và thực hiện 6 nhịp thở sâu (hít 4s – giữ 4s – thở ra 6s)."
        )
    elif streak >= 1 or heart_anomaly == "TACHYCARDIA_AT_REST":
        status = "ATTENTION"
        headline = "Phát hiện phản ứng căng thẳng mới xuất hiện — Đang theo dõi"
        recommendation = (
            "Hệ thống mới ghi nhận 1–2 cửa sổ tăng kích thích giao cảm (30–60 giây). "
            "Chưa phát báo động khẩn để tránh nhiễu tức thời; hãy thả lỏng nhịp thở."
        )
    else:
        status = "CALM"
        if recovery_seconds is not None:
            headline = f"Cơ thể đã hồi phục cân bằng sau {recovery_seconds} giây"
            recommendation = (
                "Nhịp tim, HRV và độ dẫn điện da đã quay về vùng nghỉ ổn định sau pha áp lực. "
                "Có thể tiếp tục công việc tập trung."
            )
        else:
            headline = "Trạng thái sinh lý ổn định & thư giãn"
            recommendation = (
                "Nhịp tim và biến thiên nhịp tim (HRV) nằm trong ngưỡng nghỉ cá nhân. "
                "Hệ thần kinh tự chủ đang cân bằng tốt."
            )

    real_spark_batches = [int(pt["spark_batch_id"]) for pt in spark_points if int(pt.get("spark_batch_id") or 0) > 0]

    return {
        "status": status,
        "headline": headline,
        "recommendation": recommendation,
        "latest_hr_bpm": latest_hr,
        "baseline_hr_bpm": round(float(baseline_hr), 1),
        "hr_delta_bpm": hr_delta,
        "latest_hrv_rmssd_ms": latest_vit.get("hrv_rmssd_ms"),
        "latest_eda_us": latest_eda,
        "latest_temp_c": latest_temp,
        "latest_stress_load": latest_vit.get("stress_load"),
        "latest_rf_score": latest_pred["model_score_stress"] if latest_pred else None,
        "activity_state": activity_state,
        "heart_anomaly": heart_anomaly,
        "consecutive_stress_windows": streak,
        "consecutive_stress_seconds": streak * 30,
        "stress_ratio_pct": stress_ratio_pct,
        "anomaly_windows_count": anomaly_count,
        "recovery_seconds": recovery_seconds,
        "spark_windows_count": len(spark_points),
        "latest_spark_batch_id": max(real_spark_batches) if real_spark_batches else None,
    }


@app.get("/devices/{subject_id}/predictions")
def device_predictions(subject_id: str, limit: int = 20) -> list[dict[str, Any]]:
    if not subject_id.startswith("S") or not subject_id[1:].isdigit():
        raise HTTPException(status_code=422, detail="Invalid subject ID")
    if not 1 <= limit <= 100:
        raise HTTPException(status_code=422, detail="limit must be between 1 and 100")

    if DEMO_MODE or subject_id in demo_predictions:
        rows = list(demo_predictions.get(subject_id, []))
        rows.sort(key=lambda item: str(item["window_start"]), reverse=True)
        return rows[:limit]

    try:
        with _db_lock:
            conn = _get_db()
            rows = conn.execute(
                """
                SELECT subject_id, window_start, window_end, prediction,
                       model_score_stress, model_file, model_version, sample_counts, vitals
                FROM stress_predictions
                WHERE subject_id = %s
                ORDER BY created_at DESC, window_start DESC
                LIMIT %s
                """,
                (subject_id, limit),
            ).fetchall()
    except psycopg.Error as error:
        _reset_db()
        raise HTTPException(status_code=503, detail="Could not read prediction history") from error
    return rows


@app.get("/devices/{subject_id}/timeline")
def device_timeline(subject_id: str, limit: int = 24) -> dict[str, Any]:
    if not subject_id.startswith("S") or not subject_id[1:].isdigit():
        raise HTTPException(status_code=422, detail="Invalid subject ID")
    if not 1 <= limit <= 120:
        raise HTTPException(status_code=422, detail="limit must be between 1 and 120")

    with sessions_lock:
        active_sess = sessions.get(subject_id)
        sess_pub = public_session(subject_id, active_sess) if active_sess else None
        sess_started_dt: datetime | None = active_sess.get("started_at_dt") if active_sess else None
        is_active_stream = bool(
            sess_pub
            and (
                sess_pub["producer_status"] in {"starting", "running"}
                or sess_pub["edge_status"] == "starting"
            )
        )

    if DEMO_MODE or (subject_id in demo_predictions and active_sess and active_sess.get("is_demo")):
        with sessions_lock:
            preds = [dict(r) for r in demo_predictions.get(subject_id, [])][-limit:]
            raw_spark = [dict(r) for r in demo_spark_rows.get(subject_id, [])][-(limit * 18) :]
            spark_points = _pivot_spark_rows(raw_spark)
            for item in preds:
                w_key = (subject_id, _iso_utc(item["window_start"]))
                item["window_start"] = _iso_utc(item["window_start"])
                item["window_end"] = _iso_utc(item["window_end"])
                item["vitals"] = _backfill_legacy_vitals(item, spark_points)
                item["feedback"] = demo_feedback.get(w_key)
        summary = _build_clinical_summary(preds, spark_points, is_warming_up=is_active_stream)
        return {
            "mode": "demo_replay",
            "subject_id": subject_id,
            "summary": summary,
            "predictions": preds,
            "spark_series": spark_points[-(limit * 3) :],
        }

    try:
        with _db_lock:
            conn = _get_db()
            raw_preds = conn.execute(
                """
                SELECT p.subject_id, p.window_start, p.window_end, p.prediction,
                       p.model_score_stress, p.model_file, p.model_version,
                       p.sample_counts, p.vitals, p.created_at,
                       f.verdict AS feedback_verdict, f.note AS feedback_note
                FROM stress_predictions p
                LEFT JOIN prediction_feedback f
                  ON f.subject_id = p.subject_id AND f.window_start = p.window_start
                WHERE p.subject_id = %s
                ORDER BY p.created_at DESC, p.window_start DESC
                LIMIT 60
                """,
                (subject_id,),
            ).fetchall()

            # Isolate current session if started during this run; otherwise isolate latest contiguous segment
            if sess_started_dt is not None:
                cutoff = sess_started_dt - timedelta(seconds=2)
                session_preds = [r for r in raw_preds if _to_dt(r["created_at"]) >= cutoff]
                if session_preds:
                    selected_preds = _extract_latest_contiguous_segment(session_preds, limit)
                elif is_active_stream:
                    selected_preds = []
                else:
                    selected_preds = _extract_latest_contiguous_segment(raw_preds, limit)
            else:
                selected_preds = _extract_latest_contiguous_segment(raw_preds, limit)

            spark_raw: list[dict[str, Any]] = []
            if selected_preds:
                min_ws = _to_dt(selected_preds[0]["window_start"])
                max_we = _to_dt(selected_preds[-1]["window_end"])
                spark_raw = conn.execute(
                    """
                    SELECT subject_id, window_start_utc, window_end_utc, sensor, unit,
                           sample_count, mean_value, min_value, max_value, spark_batch_id
                    FROM sensor_window_aggregates
                    WHERE subject_id = %s
                      AND window_start_utc >= %s
                      AND window_end_utc <= %s
                    ORDER BY window_start_utc ASC, ingested_at ASC, spark_batch_id ASC
                    """,
                    (subject_id, min_ws, max_we),
                ).fetchall()
    except psycopg.Error as error:
        _reset_db()
        raise HTTPException(
            status_code=503,
            detail="Không đọc được dữ liệu từ PostgreSQL (hãy kiểm tra container postgres).",
        ) from error

    spark_points = _pivot_spark_rows(spark_raw)
    preds_chrono: list[dict[str, Any]] = []
    for row in selected_preds:
        item = {
            "subject_id": row["subject_id"],
            "window_start": _iso_utc(row["window_start"]),
            "window_end": _iso_utc(row["window_end"]),
            "prediction": row["prediction"],
            "model_score_stress": float(row["model_score_stress"]),
            "model_file": row["model_file"],
            "model_version": row["model_version"],
            "sample_counts": row["sample_counts"],
            "vitals": row.get("vitals") or {},
            "feedback": (
                {"verdict": row["feedback_verdict"], "note": row["feedback_note"] or ""}
                if row.get("feedback_verdict")
                else None
            ),
        }
        item["vitals"] = _backfill_legacy_vitals(item, spark_points)
        preds_chrono.append(item)

    merged_10s = _merge_subwindow_fallbacks(preds_chrono, spark_points) if preds_chrono else spark_points
    summary = _build_clinical_summary(preds_chrono, merged_10s, is_warming_up=is_active_stream)
    return {
        "mode": "live_stack",
        "subject_id": subject_id,
        "summary": summary,
        "predictions": preds_chrono,
        "spark_series": merged_10s,
    }


@app.post("/feedback")
def save_feedback(request: FeedbackRequest) -> dict[str, Any]:
    try:
        parsed_dt = datetime.fromisoformat(request.window_start.replace("Z", "+00:00")).astimezone(
            timezone.utc
        )
    except ValueError as error:
        raise HTTPException(status_code=422, detail="Invalid window_start timestamp") from error

    norm_iso = parsed_dt.isoformat()
    payload = {
        "subject_id": request.subject_id,
        "window_start": norm_iso,
        "verdict": request.verdict,
        "note": request.note.strip(),
    }

    if DEMO_MODE or (request.subject_id in demo_predictions and sessions.get(request.subject_id, {}).get("is_demo", DEMO_MODE)):
        with sessions_lock:
            demo_feedback[(request.subject_id, norm_iso)] = {
                "verdict": request.verdict,
                "note": request.note.strip(),
            }
        return payload

    try:
        with _db_lock:
            conn = _get_db()
            conn.execute(
                """
                INSERT INTO prediction_feedback (subject_id, window_start, verdict, note, updated_at)
                VALUES (%s, %s, %s, %s, NOW())
                ON CONFLICT (subject_id, window_start) DO UPDATE SET
                    verdict = EXCLUDED.verdict,
                    note = EXCLUDED.note,
                    updated_at = NOW()
                """,
                (request.subject_id, parsed_dt, request.verdict, request.note.strip()),
            )
    except psycopg.Error as error:
        _reset_db()
        raise HTTPException(status_code=503, detail="Could not save user feedback") from error
    return payload


@app.get("/devices/{subject_id}/logs")
def device_logs(subject_id: str) -> dict[str, list[str]]:
    with sessions_lock:
        session = sessions.get(subject_id)
        if session is None:
            raise HTTPException(status_code=404, detail=f"No session for {subject_id}")
        if session.get("is_demo"):
            return {
                "producer": list(session.get("demo_producer_logs", []))[-30:],
                "edge": list(session.get("demo_edge_logs", []))[-30:],
            }
        return {
            "producer": read_tail(session.get("producer_log"), 30),
            "edge": read_tail(session.get("edge_log"), 30),
        }
