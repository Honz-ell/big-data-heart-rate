"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

const DEVICE_API = "http://localhost:8001";
const REGISTRY_API = "http://localhost:8000";

type Device = {
  device_id: string;
  subject_id: string;
  scenario_offset_seconds: number;
  duration_seconds: number;
  speed: number;
  created_at: string;
  producer_status: string;
  edge_status: string;
  consumer_group: string;
  producer_logs: string[];
  edge_logs: string[];
};

type Model = {
  version: string;
  model_file: string;
  sha256: string;
  feature_schema_version: string;
  metrics: Record<string, unknown>;
  is_active: boolean;
  created_at: string;
};

type Prediction = {
  subject_id: string;
  window_start: string;
  window_end: string;
  prediction: "STRESS" | "NON_STRESS";
  model_score_stress: number;
  model_file: string;
  model_version: string | null;
  sample_counts: Record<string, number>;
};

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || String(response.status) + " " + response.statusText);
  }
  return response.json() as Promise<T>;
}

function prettyTime(value: string): string {
  return new Date(value).toLocaleString("vi-VN", { hour12: false });
}

function stateLabel(value: string): string {
  if (value === "running") return "Đang chạy";
  if (value === "completed") return "Đã phát xong";
  if (value.startsWith("failed")) return "Lỗi";
  return "Đã dừng";
}

export default function Home() {
  const [subjects, setSubjects] = useState<string[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [activeModel, setActiveModel] = useState<Model | null>(null);
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [subjectId, setSubjectId] = useState("S4");
  const [offset, setOffset] = useState(300);
  const [duration, setDuration] = useState(40);
  const [speed, setSpeed] = useState(60);
  const [busy, setBusy] = useState(false);
  const [deviceApiOnline, setDeviceApiOnline] = useState<boolean | null>(null);
  const [registryOnline, setRegistryOnline] = useState<boolean | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const results = await Promise.allSettled([
      getJson<Device[]>(DEVICE_API + "/devices"),
      getJson<string[]>(DEVICE_API + "/subjects"),
      getJson<Model[]>(REGISTRY_API + "/models"),
      getJson<Model>(REGISTRY_API + "/models/active"),
      getJson<Prediction[]>(DEVICE_API + "/devices/" + subjectId + "/predictions?limit=8"),
    ]);
    const deviceResult = results[0];
    const subjectResult = results[1];
    const modelResult = results[2];
    const activeResult = results[3];
    const predictionResult = results[4];
    setDeviceApiOnline(deviceResult.status === "fulfilled");
    setRegistryOnline(modelResult.status === "fulfilled" && activeResult.status === "fulfilled");
    if (deviceResult.status === "fulfilled") setDevices(deviceResult.value);
    if (subjectResult.status === "fulfilled") {
      setSubjects(subjectResult.value);
      if (subjectResult.value.length && !subjectResult.value.includes(subjectId)) {
        setSubjectId(subjectResult.value[0]);
      }
    }
    if (modelResult.status === "fulfilled") setModels(modelResult.value);
    if (activeResult.status === "fulfilled") setActiveModel(activeResult.value);
    if (predictionResult.status === "fulfilled") setPredictions(predictionResult.value);
    if (deviceResult.status === "rejected" || activeResult.status === "rejected") {
      setError("Chưa kết nối đủ API. Hãy bật Device Manager và Model Registry.");
    } else {
      setError("");
    }
  }, [subjectId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const selectedDevice = useMemo(
    () => devices.find((device) => device.subject_id === subjectId),
    [devices, subjectId],
  );
  const isSelectedRunning =
    selectedDevice?.producer_status === "running" || selectedDevice?.edge_status === "running";

  async function startDevice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await getJson<Device>(DEVICE_API + "/devices/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject_id: subjectId,
          start_offset_seconds: offset,
          duration_seconds: duration,
          speed,
        }),
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Không thể khởi động thiết bị.");
    } finally {
      setBusy(false);
    }
  }

  async function stopDevice(target: string) {
    setBusy(true);
    setError("");
    try {
      await getJson<Device>(DEVICE_API + "/devices/" + target + "/stop", { method: "POST" });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Không thể dừng thiết bị.");
    } finally {
      setBusy(false);
    }
  }

  async function activateModel(version: string) {
    setBusy(true);
    setError("");
    try {
      await getJson<{ active_version: string }>(
        REGISTRY_API + "/models/" + version + "/activate",
        { method: "PUT" },
      );
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Không thể kích hoạt model.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand-mark">W</div>
        <div className="brand-title">WESAD EDGE</div>
        <div className="brand-subtitle">Wearable stress lab</div>
        <div className="side-rule" />
        <div className="nav-item active"><span>▦</span> Thiết bị</div>
        <div className="nav-item"><span>◉</span> Model Registry</div>
        <div className="nav-item"><span>▥</span> Dự đoán</div>
        <div className="sidebar-note">
          Bản mô phỏng nghiên cứu
          <br />
          Dữ liệu phát lại từ WESAD
        </div>
      </aside>

      <section className="main">
        <header className="topbar">
          <div>
            <div className="eyebrow">EDGE CONTROL CENTER</div>
            <h1>Wearable Stress Console</h1>
          </div>
          <div className="connection-list">
            <span className={"connection " + (deviceApiOnline ? "online" : "")}>
              <i /> Device API {deviceApiOnline ? "Online" : "Offline"}
            </span>
            <span className={"connection " + (registryOnline ? "online" : "")}>
              <i /> Registry {registryOnline ? "Online" : "Offline"}
            </span>
          </div>
        </header>

        {error && <div className="error-banner">{error}</div>}

        <div className="summary-grid">
          <div className="summary-card">
            <span className="summary-label">Thiết bị đang chạy</span>
            <strong>{devices.filter((device) => device.edge_status === "running").length}</strong>
            <span className="summary-caption">Edge simulator hoạt động</span>
          </div>
          <div className="summary-card">
            <span className="summary-label">Model đang active</span>
            <strong className="model-version">{activeModel?.version ?? "—"}</strong>
            <span className="summary-caption">{activeModel?.model_file ?? "Chưa đăng ký model"}</span>
          </div>
          <div className="summary-card">
            <span className="summary-label">Cửa sổ dự đoán gần nhất</span>
            <strong>{predictions.length}</strong>
            <span className="summary-caption">Bản ghi gần nhất của {subjectId}</span>
          </div>
        </div>

        <div className="content-grid">
          <section className="panel control-panel">
            <div className="panel-heading">
              <div>
                <div className="eyebrow">SIMULATOR</div>
                <h2>Khởi chạy thiết bị</h2>
              </div>
              <span className="panel-icon">▶</span>
            </div>
            <p className="panel-description">
              Chọn participant, khoảng dữ liệu và tốc độ phát. Device Manager khởi động Edge trước,
              sau đó phát WESAD vào Kafka.
            </p>
            <form onSubmit={startDevice} className="control-form">
              <label>
                Participant / Device
                <select value={subjectId} onChange={(event) => setSubjectId(event.target.value)}>
                  {(subjects.length ? subjects : ["S4"]).map((subject) => (
                    <option key={subject} value={subject}>{subject} · wearable-{subject.toLowerCase()}</option>
                  ))}
                </select>
              </label>
              <div className="form-row">
                <label>
                  Offset (giây)
                  <input type="number" min={0} step={30} value={offset}
                    onChange={(event) => setOffset(Number(event.target.value))} />
                </label>
                <label>
                  Thời lượng
                  <div className="input-suffix">
                    <input type="number" min={30} max={600} value={duration}
                      onChange={(event) => setDuration(Number(event.target.value))} />
                    <span>giây</span>
                  </div>
                </label>
              </div>
              <label>
                Tốc độ phát
                <div className="input-suffix">
                  <input type="number" min={1} max={120} value={speed}
                    onChange={(event) => setSpeed(Number(event.target.value))} />
                  <span>× thời gian</span>
                </div>
              </label>
              <div className="button-row">
                <button className="button primary" disabled={busy || isSelectedRunning} type="submit">
                  {busy ? "Đang xử lý…" : "▶  Start replay"}
                </button>
                <button className="button secondary" disabled={busy || !isSelectedRunning}
                  onClick={() => void stopDevice(subjectId)} type="button">
                  ■  Stop
                </button>
              </div>
            </form>
            <div className="hint">Gợi ý demo S4: offset 300s là Non-Stress; offset 3690s là Stress.</div>
          </section>

          <section className="panel model-panel">
            <div className="panel-heading">
              <div>
                <div className="eyebrow">MODEL GOVERNANCE</div>
                <h2>Model Registry</h2>
              </div>
              <span className="active-tag">ACTIVE · {activeModel?.version ?? "—"}</span>
            </div>
            <p className="panel-description">
              Kích hoạt phiên bản mới. Edge đang chạy sẽ nhận model mới khi poll Registry.
            </p>
            <div className="model-list">
              {models.length === 0 && <div className="empty-state">Chưa có model nào trong Registry.</div>}
              {models.map((model) => (
                <div className="model-row" key={model.version}>
                  <div className="model-symbol">ML</div>
                  <div className="model-info">
                    <strong>{model.version}</strong>
                    <span>{model.model_file}</span>
                    <small>SHA-256 · {model.sha256.slice(0, 14)}…</small>
                  </div>
                  {model.is_active ? (
                    <span className="active-tag">Đang dùng</span>
                  ) : (
                    <button className="button mini" disabled={busy}
                      onClick={() => void activateModel(model.version)} type="button">
                      Kích hoạt
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>
        </div>

        <section className="panel devices-panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">LIVE SIMULATORS</div>
              <h2>Thiết bị và tiến trình</h2>
            </div>
            <span className="refresh-note">Tự làm mới mỗi 3 giây</span>
          </div>
          {devices.length === 0 ? (
            <div className="empty-state">Chưa có phiên chạy. Chọn một participant để bắt đầu.</div>
          ) : (
            <div className="device-grid">
              {devices.map((device) => (
                <article className="device-card" key={device.subject_id}>
                  <div className="device-card-top">
                    <div className="device-avatar">⌚</div>
                    <div>
                      <strong>{device.device_id}</strong>
                      <span>Participant {device.subject_id}</span>
                    </div>
                    <button className="text-button"
                      disabled={busy || (device.producer_status !== "running" && device.edge_status !== "running")}
                      onClick={() => void stopDevice(device.subject_id)} type="button">
                      Stop
                    </button>
                  </div>
                  <div className="process-row">
                    <span>Producer</span>
                    <span className={"state-pill " + (device.producer_status === "running" ? "state-running" : "")}>
                      {stateLabel(device.producer_status)}
                    </span>
                  </div>
                  <div className="process-row">
                    <span>Edge Inference</span>
                    <span className={"state-pill " + (device.edge_status === "running" ? "state-running" : "")}>
                      {stateLabel(device.edge_status)}
                    </span>
                  </div>
                  <div className="device-meta">
                    offset {device.scenario_offset_seconds}s · {device.duration_seconds}s · {device.speed}×
                  </div>
                  <details className="logs-details">
                    <summary>Xem log gần nhất</summary>
                    <div className="log-columns">
                      <pre>{device.producer_logs.join("\n") || "Chưa có log Producer."}</pre>
                      <pre>{device.edge_logs.join("\n") || "Chưa có log Edge."}</pre>
                    </div>
                  </details>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="panel predictions-panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">EDGE OUTPUT</div>
              <h2>Lịch sử dự đoán · {subjectId}</h2>
            </div>
            <span className="refresh-note">Từ PostgreSQL</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Bắt đầu cửa sổ</th><th>Kết quả</th><th>Điểm Stress</th><th>Model</th><th>Mẫu nhận được</th></tr>
              </thead>
              <tbody>
                {predictions.map((prediction) => (
                  <tr key={prediction.subject_id + "-" + prediction.window_start}>
                    <td>{prettyTime(prediction.window_start)}</td>
                    <td>
                      <span className={"prediction-pill " + (prediction.prediction === "STRESS" ? "stress" : "calm")}>
                        {prediction.prediction}
                      </span>
                    </td>
                    <td>
                      <div className="score-cell">
                        <span>{prediction.model_score_stress.toFixed(3)}</span>
                        <div className="score-track">
                          <i style={{ width: String(prediction.model_score_stress * 100) + "%" }} />
                        </div>
                      </div>
                    </td>
                    <td>{prediction.model_version ?? prediction.model_file}</td>
                    <td className="sample-cell">
                      ACC {prediction.sample_counts.ACC ?? 0} · BVP {prediction.sample_counts.BVP ?? 0}
                    </td>
                  </tr>
                ))}
                {predictions.length === 0 && (
                  <tr><td className="empty-cell" colSpan={5}>Chưa có kết quả cho participant này.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="footnote">Điểm Stress là đầu ra của Random Forest, không phải xác suất chẩn đoán y tế.</p>
        </section>

        <footer>WESAD Stress Edge · replay mô phỏng · Kafka → Edge → PostgreSQL</footer>
      </section>
    </main>
  );
}
