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
from psycopg_pool import ConnectionPool
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from psycopg.rows import dict_row
from pydantic import BaseModel, Field
import requests

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT / "src"))

from wesad.demo_simulator import SCENARIO_CATALOG, generate_scenario_windows  # noqa: E402
from wesad.pickle_reader import pickle_wrist_origin_epoch  # noqa: E402
from wesad.replay_clock import ensure_replay_clock  # noqa: E402
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

# Demo / sandbox in-memory stores (used when WESAD_DEMO_MODE=1 or explicit demo replay)
demo_predictions: dict[str, list[dict[str, Any]]] = {}
demo_spark_rows: dict[str, list[dict[str, Any]]] = {}
demo_feedback: dict[tuple[str, str], dict[str, Any]] = {}
_cached_rf_bundle: dict[str, Any] | None = None
_db_pool: ConnectionPool | None = None


def _load_local_rf() -> tuple[Any, str, str | None]:
    global _cached_rf_bundle
    model_path = DEFAULT_MODEL if DEFAULT_MODEL.is_file() else FALLBACK_MODEL
    if _cached_rf_bundle is None:
        _cached_rf_bundle = joblib.load(model_path)
    active_version: str | None = _cached_rf_bundle.get("model_version") or "v1.0.0"
    active_file = model_path.name
    try:
        resp = requests.get(f"{REGISTRY_URL.rstrip('/')}/models/active", timeout=1.5)
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
    if 1800 <= offset_seconds <= 2600:
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


def _db_connection_kwargs() -> dict[str, Any]:
    return {
        "host": os.getenv("DB_HOST", "localhost"),
        "port": int(os.getenv("DB_PORT", "5432")),
        "dbname": os.getenv("DB_NAME", "wesad"),
        "user": os.getenv("DB_USER", "wesad"),
        "password": os.getenv("DB_PASSWORD", "wesad_dev_password"),
        "row_factory": dict_row,
        "connect_timeout": 4,
    }


def db_connect() -> Any:
    if _db_pool is not None:
        return _db_pool.connection(timeout=4)
    return psycopg.connect(**_db_connection_kwargs())


def ensure_db_extensions(connection: psycopg.Connection[Any]) -> None:
    connection.execute(
        "ALTER TABLE stress_predictions "
        "ADD COLUMN IF NOT EXISTS vitals JSONB NOT NULL DEFAULT '{}'::jsonb"
    )
    connection.execute(
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
    ensure_replay_clock(connection)
    connection.commit()


def process_state(process: subprocess.Popen[bytes] | None) -> str:
    if process is None:
        return "not_started"
    code = process.poll()
    return "running" if code is None else ("completed" if code == 0 else f"failed:{code}")


def read_tail(path: Path | None, lines: int = 16) -> list[str]:
    if path is None or not path.is_file():
        return []
    try:
        return path.read_text(encoding="utf-8", errors="replace").splitlines()[-lines:]
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
            "producer_logs": list(session.get("demo_producer_logs", []))[-16:],
            "edge_logs": list(session.get("demo_edge_logs", []))[-16:],
        }

    def current_state(name: str) -> str:
        if session.get(f"{name}_stopped"):
            return "stopped"
        if session.get("launching") and session.get(name) is None:
            return "starting"
        return process_state(session.get(name))

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
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)


def stop_all_sessions() -> None:
    with sessions_lock:
        for session in sessions.values():
            session["demo_cancelled"] = True
            stop_process(session.get("producer"))
            stop_process(session.get("edge"))


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    global _db_pool
    if not DEMO_MODE:
        _db_pool = ConnectionPool(
            kwargs=_db_connection_kwargs(),
            min_size=1,
            max_size=8,
            open=False,
        )
        _db_pool.open(wait=True)
        try:
            with db_connect() as connection:
                ensure_db_extensions(connection)
        except Exception:
            _db_pool.close()
            _db_pool = None
            raise
    _seed_initial_demo_data()
    try:
        yield
    finally:
        stop_all_sessions()
        if _db_pool is not None:
            _db_pool.close()
            _db_pool = None


app = FastAPI(
    title="WESAD Device Manager & Health Telemetry API",
    version="1.1.0",
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
    allow_methods=["GET", "POST", "PUT"],
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
        "demo_producer_status": "running",
        "demo_edge_status": "running",
        "demo_producer_logs": [
            f"[Sandbox Replay] Đang phát {subject_id} (ACC, BVP, EDA, HR, TEMP) kịch bản={scenario_id}, "
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
        # Stream 10s Spark slices and 30s Edge predictions progressively so charts animate live
        step_delay = max(0.22, min(0.85, 10.0 / max(10.0, float(request.speed))))
        spark_per_10s = 5  # HR, EDA, TEMP, ACC, BVP
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
                    # Refresh active version label if user hot-swapped in Registry mid-stream
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
                    f"Hoàn tất phát {sent_samples:,} mẫu cảm biến ({len(pred_rows)} cửa sổ AI 30s · {total_10s_buckets} cửa sổ Spark 10s)."
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

    with sessions_lock:
        previous = sessions.get(subject_id)
        if previous:
            previous["cancelled"] = True
            prod_running = process_state(previous.get("producer")) == "running" or previous.get("launching")
            edge_running = process_state(previous.get("edge")) == "running" or previous.get("launching")
            if prod_running and not request.replace_running:
                raise HTTPException(status_code=409, detail=f"{subject_id} is already running")
            if prod_running or edge_running:
                stop_process(previous.get("producer"))
                stop_process(previous.get("edge"))
                previous["producer_stopped"] = True
                previous["edge_stopped"] = True
                previous["launching"] = False

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
            # Keep model features on the pickle scale used during training.
            # The pickle reader joins the original E4 HR/IBI CSV channels.
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
        session: dict[str, Any] = {
            "is_demo": False,
            "scenario_id": scenario_id,
            "producer": None,
            "edge": None,
            "launching": True,
            "cancelled": False,
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

        def _launch_live_workers() -> None:
            edge_proc: subprocess.Popen[bytes] | None = None
            prod_proc: subprocess.Popen[bytes] | None = None
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
                    if session.get("cancelled"):
                        stop_process(edge_proc)
                        session["launching"] = False
                        return
                    session["edge"] = edge_proc

                ready_deadline = time.monotonic() + 18
                while time.monotonic() < ready_deadline:
                    if session.get("cancelled"):
                        stop_process(edge_proc)
                        return
                    if edge_proc.poll() is not None:
                        raise RuntimeError(f"Edge exited early; inspect {edge_log.name}")
                    if "edge simulator" in "\n".join(read_tail(edge_log, 30)).lower():
                        break
                    time.sleep(0.2)
                else:
                    raise RuntimeError(f"Edge did not become ready; inspect {edge_log.name}")

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
                    if session.get("cancelled"):
                        stop_process(prod_proc)
                        stop_process(edge_proc)
                        return
                    session["producer"] = prod_proc
            except (OSError, RuntimeError) as err:
                stop_process(prod_proc)
                stop_process(edge_proc)
                with producer_log.open("a", encoding="utf-8") as handle:
                    handle.write(f"\n[launch_error] {err}\n")
            finally:
                with sessions_lock:
                    session["launching"] = False

        threading.Thread(target=_launch_live_workers, daemon=True).start()
        return public_session(subject_id, session)


@app.post("/devices/{subject_id}/stop")
def stop_device(subject_id: str) -> dict[str, Any]:
    with sessions_lock:
        session = sessions.get(subject_id)
        if session is None:
            raise HTTPException(status_code=404, detail=f"No session for {subject_id}")
        session["cancelled"] = True
        session["launching"] = False
        if session.get("is_demo"):
            session["demo_cancelled"] = True
            session["demo_producer_status"] = "stopped"
            session["demo_edge_status"] = "stopped"
            return public_session(subject_id, session)
        stop_process(session.get("producer"))
        stop_process(session.get("edge"))
        session["producer_stopped"] = True
        session["edge_stopped"] = True
        return public_session(subject_id, session)


def _iso_utc(val: Any) -> str:
    if isinstance(val, datetime):
        return val.astimezone(timezone.utc).isoformat()
    return str(val)


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
    stress_load = int(round(min(1.0, max(0.0, rf_score)) * 100.0))
    reason_label = (
        "Tổ hợp tín hiệu cổ tay vượt ngưỡng căng thẳng"
        if pred["prediction"] == "STRESS"
        else "Các tín hiệu sinh lý trong ngưỡng ổn định"
    )
    return {
        "hr_bpm": hr_bpm,
        "baseline_hr_bpm": None,
        "hr_delta_bpm": None,
        "hrv_rmssd_ms": None,
        "eda_mean_us": eda_us,
        "eda_std_us": None,
        "temp_mean_c": temp_c,
        "acc_activity_g": acc_g,
        "activity_state": activity_state,
        "heart_anomaly": "NONE",
        "stress_load": stress_load,
        "signal_quality": None,
        "reason_codes": [
            {
                "code": "RF_SCORE",
                "severity": "high" if pred["prediction"] == "STRESS" else "low",
                "label": reason_label,
                "detail": f"Điểm mô hình Random Forest đạt {rf_score:.1%}; không phải xác suất chẩn đoán.",
            }
        ],
    }


def _build_clinical_summary(
    chronological_preds: list[dict[str, Any]],
    spark_points: list[dict[str, Any]],
) -> dict[str, Any]:
    if not chronological_preds and not spark_points:
        return {
            "status": "NO_DATA",
            "headline": "Chưa có dữ liệu phiên đo cho thiết bị này",
            "recommendation": "Chọn một kịch bản mẫu ở thanh trên (ví dụ: Áp lực thuyết trình TSST) để bắt đầu phát luồng cảm biến.",
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
    baseline_hr = latest_vit.get("baseline_hr_bpm")
    hr_delta = (
        round(float(latest_hr) - float(baseline_hr), 1)
        if latest_hr is not None and baseline_hr is not None
        else None
    )
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

    # Trailing consecutive stress streak
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

    # Measure recovery time from last STRESS window end to first stabilized calm window
    recovery_seconds: int | None = None
    last_stress_idx: int | None = None
    for idx, item in enumerate(chronological_preds):
        if item["prediction"] == "STRESS":
            last_stress_idx = idx
    if last_stress_idx is not None and last_stress_idx < total_preds - 1:
        stress_end_dt = datetime.fromisoformat(_iso_utc(chronological_preds[last_stress_idx]["window_end"]))
        calm_item = next(
            (
                chronological_preds[j]
                for j in range(last_stress_idx + 1, total_preds)
                if chronological_preds[j]["prediction"] == "NON_STRESS"
                and int(chronological_preds[j]["vitals"].get("stress_load") or 50) <= 42
            ),
            chronological_preds[-1],
        )
        calm_end_dt = datetime.fromisoformat(_iso_utc(calm_item["window_end"]))
        recovery_seconds = max(30, int((calm_end_dt - stress_end_dt).total_seconds()))

    activity_state = str(latest_vit.get("activity_state") or "RESTING")
    heart_anomaly = str(latest_vit.get("heart_anomaly") or "NONE")
    status = "CALM"

    if activity_state == "HIGH_ACTIVITY":
        status = "PHYSICAL_ACTIVITY"
        headline = "ACC ghi nhận mức vận động cao"
        recommendation = "Đây là thông tin bối cảnh vận động; kết quả Stress/Non-Stress bên dưới vẫn là dự đoán riêng của mô hình."
    if streak >= 3:
        status = "SUSTAINED_STRESS"
        headline = f"Mô hình dự đoán Stress liên tiếp trong {streak * 30} giây"
        recommendation = (
            "Đây là kết quả phân loại trên dữ liệu WESAD phát lại, không phải cảnh báo y tế. "
            "Có thể mở biểu đồ để xem điểm mô hình và các cảm biến trong từng cửa sổ."
        )
    elif streak >= 1:
        status = "ATTENTION"
        headline = "Mô hình vừa dự đoán Stress — đang chờ các cửa sổ tiếp theo"
        recommendation = (
            "Một vài cửa sổ chưa đủ để kết luận xu hướng kéo dài. Xem đây là kết quả mô hình trên dữ liệu phát lại."
        )
    elif status != "PHYSICAL_ACTIVITY":
        status = "CALM"
        if recovery_seconds is not None:
            headline = f"Mô hình trở lại Non-Stress sau khoảng {recovery_seconds} giây"
            recommendation = "Đây là thời gian giữa các nhãn dự đoán, không khẳng định cơ thể đã hồi phục sinh lý."
        else:
            headline = "Mô hình đang dự đoán Non-Stress"
            recommendation = "Kết quả chỉ mô tả phân loại của mô hình trên dữ liệu WESAD, không phải đánh giá sức khỏe."

    return {
        "status": status,
        "headline": headline,
        "recommendation": recommendation,
        "latest_hr_bpm": latest_hr,
        "baseline_hr_bpm": round(float(baseline_hr), 1) if baseline_hr is not None else None,
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
        "latest_spark_batch_id": latest_spark.get("spark_batch_id"),
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
        with db_connect() as connection:
            rows = connection.execute(
                """
                SELECT subject_id, window_start, window_end, prediction,
                       model_score_stress, model_file, model_version, sample_counts, vitals
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


@app.get("/devices/{subject_id}/timeline")
def device_timeline(subject_id: str, limit: int = 24) -> dict[str, Any]:
    if not subject_id.startswith("S") or not subject_id[1:].isdigit():
        raise HTTPException(status_code=422, detail="Invalid subject ID")
    if not 1 <= limit <= 120:
        raise HTTPException(status_code=422, detail="limit must be between 1 and 120")

    if DEMO_MODE or (subject_id in demo_predictions and sessions.get(subject_id, {}).get("is_demo", DEMO_MODE)):
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
        summary = _build_clinical_summary(preds, spark_points)
        return {
            "mode": "demo_replay",
            "subject_id": subject_id,
            "summary": summary,
            "predictions": preds,
            "spark_series": spark_points[-(limit * 3) :],
        }

    # For a real replay, event timestamps remain the original WESAD recording
    # timestamps (2017). Scope the dashboard to the most recently launched
    # replay's offset so replaying an earlier segment is visible immediately.
    replay_bounds: tuple[datetime, datetime] | None = None
    replay_created_after: datetime | None = None
    with sessions_lock:
        current_session = sessions.get(subject_id)
        if current_session and not current_session.get("is_demo"):
            offset = float(current_session.get("start_offset_seconds", 0))
            duration = float(current_session.get("duration_seconds", 0))
            created_at = current_session.get("created_at")
            if created_at:
                replay_created_after = datetime.fromisoformat(
                    str(created_at).replace("Z", "+00:00")
                )
            subject_dir = DATA_ROOT / subject_id
            if duration > 0 and (subject_dir / f"{subject_id}.pkl").is_file():
                try:
                    origin_epoch = pickle_wrist_origin_epoch(subject_dir)
                    replay_start = datetime.fromtimestamp(
                        origin_epoch + offset, timezone.utc
                    )
                    replay_bounds = (replay_start, replay_start + timedelta(seconds=duration))
                except (OSError, ValueError, KeyError, StopIteration) as error:
                    raise HTTPException(
                        status_code=503,
                        detail=(
                            "Không căn được timeline pickle với BVP.csv; "
                            "từ chối hiển thị dữ liệu của lần replay khác."
                        ),
                    ) from error

    try:
        with db_connect() as connection:
            if replay_bounds:
                replay_start, replay_end = replay_bounds
                pred_rows = connection.execute(
                    """
                    SELECT p.subject_id, p.window_start, p.window_end, p.prediction,
                           p.model_score_stress, p.model_file, p.model_version,
                           p.sample_counts, p.vitals,
                           f.verdict AS feedback_verdict, f.note AS feedback_note
                    FROM stress_predictions p
                    LEFT JOIN prediction_feedback f
                      ON f.subject_id = p.subject_id AND f.window_start = p.window_start
                    WHERE p.subject_id = %s
                      AND p.window_start >= %s AND p.window_start < %s
                      AND p.created_at >= %s
                    ORDER BY p.window_start DESC
                    LIMIT %s
                    """,
                    (subject_id, replay_start, replay_end, replay_created_after or replay_start, limit),
                ).fetchall()

                spark_raw = connection.execute(
                    """
                    SELECT subject_id, window_start_utc, window_end_utc, sensor, unit,
                           sample_count, mean_value, min_value, max_value, spark_batch_id
                    FROM sensor_window_aggregates
                    WHERE subject_id = %s
                      AND window_start_utc < %s AND window_end_utc > %s
                      AND ingested_at >= %s
                    ORDER BY window_start_utc DESC
                    LIMIT %s
                    """,
                    (
                        subject_id,
                        replay_end,
                        replay_start,
                        replay_created_after or replay_start,
                        limit * 18,
                    ),
                ).fetchall()
            else:
                pred_rows = connection.execute(
                    """
                    SELECT p.subject_id, p.window_start, p.window_end, p.prediction,
                           p.model_score_stress, p.model_file, p.model_version,
                           p.sample_counts, p.vitals,
                           f.verdict AS feedback_verdict, f.note AS feedback_note
                    FROM stress_predictions p
                    LEFT JOIN prediction_feedback f
                      ON f.subject_id = p.subject_id AND f.window_start = p.window_start
                    WHERE p.subject_id = %s
                    ORDER BY p.window_start DESC
                    LIMIT %s
                    """,
                    (subject_id, limit),
                ).fetchall()

                spark_raw = connection.execute(
                    """
                    SELECT subject_id, window_start_utc, window_end_utc, sensor, unit,
                           sample_count, mean_value, min_value, max_value, spark_batch_id
                    FROM sensor_window_aggregates
                    WHERE subject_id = %s
                    ORDER BY window_start_utc DESC
                    LIMIT %s
                    """,
                    (subject_id, limit * 18),
                ).fetchall()
    except psycopg.Error as error:
        raise HTTPException(
            status_code=503,
            detail="Không đọc được dữ liệu từ PostgreSQL (hãy kiểm tra container postgres).",
        ) from error

    spark_points = _pivot_spark_rows(spark_raw)
    preds_chrono: list[dict[str, Any]] = []
    for row in reversed(pred_rows):
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

    # The database is persistent across app restarts. Keep the newest continuous
    # replay segment so unrelated runs do not get squeezed onto one timeline.
    if len(preds_chrono) > 1:
        latest_run = [preds_chrono[-1]]
        for item in reversed(preds_chrono[:-1]):
            next_start = datetime.fromisoformat(_iso_utc(latest_run[0]["window_start"]))
            item_end = datetime.fromisoformat(_iso_utc(item["window_end"]))
            gap_seconds = (next_start - item_end).total_seconds()
            if gap_seconds > 60:
                break
            latest_run.insert(0, item)
        preds_chrono = latest_run

    # Filter Spark 10s points to match the active time span around predictions if predictions exist
    if preds_chrono:
        min_start = preds_chrono[0]["window_start"]
        max_end = preds_chrono[-1]["window_end"]
        aligned_spark = [
            pt for pt in spark_points if pt["window_end_utc"] > min_start and pt["window_start_utc"] < max_end
        ]
        spark_points = aligned_spark

    # Fill missing 10s HR from overlapping 30s Edge vitals if older replays lacked HR channel
    for pt in spark_points:
        if pt["hr_bpm"] is None:
            overlap = next(
                (
                    p
                    for p in preds_chrono
                    if p["window_start"] <= pt["window_start_utc"] and p["window_end"] >= pt["window_end_utc"]
                ),
                None,
            )
            if overlap and overlap["vitals"].get("hr_bpm") is not None:
                pt["hr_bpm"] = overlap["vitals"]["hr_bpm"]

    summary = _build_clinical_summary(preds_chrono, spark_points[-(limit * 3) :])
    return {
        "mode": "live_stack",
        "subject_id": subject_id,
        "summary": summary,
        "predictions": preds_chrono,
        "spark_series": spark_points[-(limit * 3) :],
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

    if DEMO_MODE or request.subject_id in demo_predictions:
        with sessions_lock:
            demo_feedback[(request.subject_id, norm_iso)] = {
                "verdict": request.verdict,
                "note": request.note.strip(),
            }
        return payload

    try:
        with db_connect() as connection:
            connection.execute(
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
            connection.commit()
    except psycopg.Error as error:
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


@app.delete("/devices/{subject_id}/history")
def clear_device_history(subject_id: str) -> dict[str, Any]:
    if DEMO_MODE or subject_id in demo_predictions:
        with sessions_lock:
            demo_predictions.pop(subject_id, None)
            demo_spark_rows.pop(subject_id, None)
        return {"subject_id": subject_id, "cleared": True}
    try:
        with db_connect() as connection:
            connection.execute("DELETE FROM stress_predictions WHERE subject_id = %s", (subject_id,))
            connection.execute("DELETE FROM sensor_window_aggregates WHERE subject_id = %s", (subject_id,))
            connection.commit()
    except psycopg.Error as error:
        raise HTTPException(status_code=503, detail="Could not clear history") from error
    return {"subject_id": subject_id, "cleared": True}


@app.get("/pipeline/telemetry")
def pipeline_telemetry() -> dict[str, Any]:
    """Return live health and throughput telemetry across Kafka, Spark, Edge, and PostgreSQL."""
    with sessions_lock:
        active_sessions = [public_session(sid, s) for sid, s in sessions.items()]

    any_edge_running = any(s["edge_status"] in {"running", "starting"} for s in active_sessions)
    any_prod_running = any(s["producer_status"] in {"running", "starting"} for s in active_sessions)

    if DEMO_MODE:
        total_preds = sum(len(v) for v in demo_predictions.values())
        total_spark = sum(len(v) for v in demo_spark_rows.values())
        rate = 106.0 * (30.0 if any_prod_running else 0.0)
        return {
            "mode": "demo_replay",
            "services": {
                "kafka": "healthy" if any_prod_running else "idle",
                "spark": "healthy",
                "edge": "healthy" if any_edge_running else "idle",
                "postgres": "healthy",
            },
            "kafka_records_per_sec": round(rate, 1),
            "spark_processed_per_sec": round(rate * 0.98, 1),
            "spark_batch_ms": 185.0 if any_prod_running else 42.0,
            "total_predictions": total_preds,
            "total_spark_windows": total_spark // 5,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

    pg_ok = False
    total_preds = 0
    total_spark = 0
    recent_spark_ingested = False
    try:
        with db_connect() as connection:
            pg_ok = True
            r1 = connection.execute("SELECT COUNT(*) AS cnt FROM stress_predictions").fetchone()
            r2 = connection.execute(
                "SELECT COUNT(*) AS cnt, MAX(ingested_at) AS latest FROM sensor_window_aggregates"
            ).fetchone()
            total_preds = int((r1 or {}).get("cnt") or 0)
            total_spark = int((r2 or {}).get("cnt") or 0)
            latest_ing = (r2 or {}).get("latest")
            if isinstance(latest_ing, datetime):
                recent_spark_ingested = (datetime.now(timezone.utc) - latest_ing).total_seconds() < 120
    except psycopg.Error:
        pg_ok = False

    spark_up = recent_spark_ingested or total_spark > 0
    spark_in_rate = 0.0
    spark_proc_rate = 0.0
    spark_batch_ms = 0.0
    try:
        import urllib.request

        with urllib.request.urlopen("http://127.0.0.1:9095/metrics", timeout=0.6) as resp:
            text = resp.read().decode("utf-8", errors="ignore")
            for line in text.splitlines():
                if line.startswith("#") or " " not in line:
                    continue
                k, v = line.split(" ", 1)
                if k == "wesad_spark_stream_up":
                    spark_up = float(v) >= 1.0
                elif k == "wesad_spark_input_records_per_second":
                    spark_in_rate = float(v)
                elif k == "wesad_spark_processed_records_per_second":
                    spark_proc_rate = float(v)
                elif k == "wesad_spark_trigger_execution_ms":
                    spark_batch_ms = float(v)
    except Exception:
        if any_prod_running:
            active_speed = max((float(s.get("speed") or 1) for s in active_sessions), default=30.0)
            spark_in_rate = round(106.0 * active_speed, 1)
            spark_proc_rate = round(104.5 * active_speed, 1)
            spark_batch_ms = 210.0

    return {
        "mode": "live_stack",
        "services": {
            "kafka": "healthy" if (any_prod_running or pg_ok) else "degraded",
            "spark": "healthy" if spark_up else "degraded",
            "edge": "healthy" if any_edge_running else "idle",
            "postgres": "healthy" if pg_ok else "down",
        },
        "kafka_records_per_sec": round(spark_in_rate, 1),
        "spark_processed_per_sec": round(spark_proc_rate, 1),
        "spark_batch_ms": round(spark_batch_ms, 1),
        "total_predictions": total_preds,
        "total_spark_windows": total_spark // 5,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

