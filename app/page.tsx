"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

const DEVICE_API = "/api/device";
const REGISTRY_API = "/api/registry";

type ScenarioSpec = {
  id: string;
  title: string;
  badge: string;
  tone: "calm" | "stress" | "transition" | "motion";
  subject_id: string;
  start_offset_seconds: number;
  duration_seconds: number;
  speed: number;
  description: string;
  expected_outcome: string;
};

type ReasonCode = {
  code: string;
  severity: "low" | "medium" | "high" | "info";
  label: string;
  detail: string;
};

type WindowVitals = {
  hr_bpm: number | null;
  baseline_hr_bpm: number | null;
  hr_delta_bpm: number | null;
  hrv_rmssd_ms: number | null;
  eda_mean_us: number | null;
  eda_std_us: number | null;
  temp_mean_c: number | null;
  acc_activity_g: number | null;
  activity_state: "RESTING" | "LIGHT_ACTIVITY" | "HIGH_ACTIVITY";
  heart_anomaly:
    | "NONE"
    | "TACHYCARDIA_AT_REST"
    | "ELEVATED_WITH_MOTION"
    | "LOW_HRV_STRAIN"
    | "BRADYCARDIA";
  stress_load: number | null;
  signal_quality: number | null;
  reason_codes: ReasonCode[];
};

type PredictionWindow = {
  subject_id: string;
  window_start: string;
  window_end: string;
  prediction: "STRESS" | "NON_STRESS";
  model_score_stress: number;
  model_file: string;
  model_version: string | null;
  sample_counts: Record<string, number>;
  vitals: WindowVitals;
  feedback?: { verdict: "ACCURATE" | "FALSE_ALARM"; note: string } | null;
};

type SparkPoint = {
  window_start_utc: string;
  window_end_utc: string;
  hr_bpm: number | null;
  eda_us: number | null;
  temp_c: number | null;
  acc_mean: number | null;
  acc_range: number | null;
  bvp_range: number | null;
  sample_count_total: number;
  spark_batch_id: number;
};

type ClinicalSummary = {
  status: "CALM" | "ATTENTION" | "SUSTAINED_STRESS" | "PHYSICAL_ACTIVITY" | "NO_DATA";
  headline: string;
  recommendation: string;
  latest_hr_bpm: number | null;
  baseline_hr_bpm: number | null;
  hr_delta_bpm: number | null;
  latest_hrv_rmssd_ms: number | null;
  latest_eda_us: number | null;
  latest_temp_c: number | null;
  latest_stress_load: number | null;
  latest_rf_score: number | null;
  activity_state: "RESTING" | "LIGHT_ACTIVITY" | "HIGH_ACTIVITY";
  heart_anomaly: string;
  consecutive_stress_windows: number;
  consecutive_stress_seconds: number;
  stress_ratio_pct: number;
  anomaly_windows_count: number;
  recovery_seconds: number | null;
  spark_windows_count: number;
  latest_spark_batch_id: number | null;
};

type TimelineResponse = {
  mode: "live_stack" | "demo_replay";
  subject_id: string;
  summary: ClinicalSummary;
  predictions: PredictionWindow[];
  spark_series: SparkPoint[];
};

type DeviceSession = {
  device_id: string;
  subject_id: string;
  scenario_id?: string | null;
  scenario_offset_seconds: number;
  duration_seconds: number;
  speed: number;
  created_at: string;
  producer_status: string;
  edge_status: string;
  consumer_group: string;
  mode?: string;
  producer_logs: string[];
  edge_logs: string[];
};

type ModelRecord = {
  version: string;
  model_file: string;
  sha256: string;
  feature_schema_version: string;
  metrics: {
    loso_mean_metrics?: { accuracy?: number; stress_f1?: number; stress_recall?: number };
    heldout_metrics?: Record<string, { accuracy?: number; stress_f1?: number }>;
  };
  is_active: boolean;
  created_at: string;
  activated_at: string | null;
};

type ChartMetric = "hr" | "eda" | "temp" | "load";

const DEFAULT_SUBJECTS = ["S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S13", "S14", "S15", "S16", "S17"];

const FEATURE_GROUP_IMPORTANCE = [
  { name: "Dẫn điện da (EDA — mồ hôi giao cảm)", pct: 43.8, color: "var(--teal)" },
  { name: "Gia tốc cổ tay 3 trục (ACC — bối cảnh vận động)", pct: 26.4, color: "var(--sky)" },
  { name: "Nhiệt độ da ngoại vi (TEMP — co/giãn mạch)", pct: 18.2, color: "var(--amber)" },
  { name: "Sóng mạch quang học (BVP — biên độ tim mạch)", pct: 11.6, color: "#c084fc" },
];

function fmtClock(iso: string): string {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  return dt.toISOString().slice(11, 19);
}

function fmtActivityVi(state: string): { label: string; cls: string } {
  if (state === "HIGH_ACTIVITY") return { label: "Đang vận động mạnh", cls: "pill pill-motion" };
  if (state === "LIGHT_ACTIVITY") return { label: "Chuyển động nhẹ", cls: "pill pill-warn" };
  return { label: "Ngồi tĩnh / Nghỉ", cls: "pill pill-calm" };
}

function fmtAnomalyVi(code: string): { label: string; cls: string } {
  switch (code) {
    case "TACHYCARDIA_AT_REST":
      return { label: "Nhịp nhanh khi ngồi tĩnh", cls: "pill pill-stress" };
    case "ELEVATED_WITH_MOTION":
      return { label: "Tăng nhịp phù hợp vận động", cls: "pill pill-motion" };
    case "LOW_HRV_STRAIN":
      return { label: "HRV giảm · Căng giao cảm", cls: "pill pill-warn" };
    case "BRADYCARDIA":
      return { label: "Nhịp tim thấp (< 48 BPM)", cls: "pill pill-warn" };
    default:
      return { label: "Nhịp tim bình thường", cls: "pill pill-calm" };
  }
}

export default function HomePage() {
  const [activeTab, setActiveTab] = useState<"user" | "ops">("user");
  const [subjects, setSubjects] = useState<string[]>(DEFAULT_SUBJECTS);
  const [selectedSubject, setSelectedSubject] = useState<string>("S4");
  const [scenarios, setScenarios] = useState<ScenarioSpec[]>([]);
  const [devices, setDevices] = useState<DeviceSession[]>([]);
  const [timeline, setTimeline] = useState<TimelineResponse | null>(null);
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [selectedWindowKey, setSelectedWindowKey] = useState<string | null>(null);
  const [chartMetric, setChartMetric] = useState<ChartMetric>("hr");

  // Custom Engineer form state
  const [offsetSeconds, setOffsetSeconds] = useState<number>(3690);
  const [durationSeconds, setDurationSeconds] = useState<number>(180);
  const [speed, setSpeed] = useState<number>(30);

  // Interactive breathing pacer
  const [breathingOpen, setBreathingOpen] = useState<boolean>(false);
  const [breathTick, setBreathTick] = useState<number>(0);

  // Status & errors
  const [apiOnline, setApiOnline] = useState<boolean>(false);
  const [registryOnline, setRegistryOnline] = useState<boolean>(false);
  const [backendMode, setBackendMode] = useState<"live_stack" | "demo_replay">("live_stack");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const currentDevice = useMemo(
    () => devices.find((item) => item.subject_id === selectedSubject) ?? null,
    [devices, selectedSubject]
  );

  const isStreaming =
    currentDevice?.producer_status === "running" ||
    (currentDevice?.mode === "demo_replay" && currentDevice?.edge_status === "running");

  const activeModel = useMemo(
    () => models.find((item) => item.is_active) ?? null,
    [models]
  );

  const refreshData = useCallback(async () => {
    try {
      const [healthRes, devRes, tlRes] = await Promise.all([
        fetch(`${DEVICE_API}/health`, { cache: "no-store" }),
        fetch(`${DEVICE_API}/devices`, { cache: "no-store" }),
        fetch(`${DEVICE_API}/devices/${selectedSubject}/timeline?limit=24`, { cache: "no-store" }),
      ]);
      if (healthRes.ok) {
        const h = await healthRes.json();
        setApiOnline(true);
        if (h.mode === "demo_replay" || h.mode === "live_stack") {
          setBackendMode(h.mode);
        }
      } else {
        setApiOnline(false);
      }
      if (devRes.ok) {
        setDevices((await devRes.json()) as DeviceSession[]);
      }
      if (tlRes.ok) {
        const data = (await tlRes.json()) as TimelineResponse;
        setTimeline(data);
        setBackendMode(data.mode);
      }
    } catch {
      setApiOnline(false);
    }

    try {
      const regRes = await fetch(`${REGISTRY_API}/models`, { cache: "no-store" });
      if (regRes.ok) {
        setModels((await regRes.json()) as ModelRecord[]);
        setRegistryOnline(true);
      } else {
        setRegistryOnline(false);
      }
    } catch {
      setRegistryOnline(false);
    }
  }, [selectedSubject]);

  useEffect(() => {
    void (async () => {
      try {
        const [scRes, subRes] = await Promise.all([
          fetch(`${DEVICE_API}/scenarios`, { cache: "no-store" }),
          fetch(`${DEVICE_API}/subjects`, { cache: "no-store" }),
        ]);
        if (scRes.ok) {
          setScenarios((await scRes.json()) as ScenarioSpec[]);
        }
        if (subRes.ok) {
          const list = (await subRes.json()) as string[];
          if (list.length > 0) setSubjects(list);
        }
      } catch {
        // Keep defaults
      }
    })();
  }, []);

  useEffect(() => {
    void refreshData();
    const pollMs = isStreaming ? 1000 : 2800;
    const timer = window.setInterval(() => {
      void refreshData();
    }, pollMs);
    return () => window.clearInterval(timer);
  }, [refreshData, isStreaming]);

  useEffect(() => {
    if (!breathingOpen) return;
    const id = window.setInterval(() => {
      setBreathTick((prev) => (prev + 1) % 14);
    }, 1000);
    return () => window.clearInterval(id);
  }, [breathingOpen]);

  const predictions = timeline?.predictions ?? [];
  const sparkSeries = timeline?.spark_series ?? [];
  const summary = timeline?.summary ?? null;

  const selectedWindow = useMemo<PredictionWindow | null>(() => {
    if (predictions.length === 0) return null;
    if (selectedWindowKey) {
      const match = predictions.find((item) => item.window_start === selectedWindowKey);
      if (match) return match;
    }
    return predictions[predictions.length - 1];
  }, [predictions, selectedWindowKey]);

  async function launchScenario(spec: {
    scenario_id?: string;
    start_offset_seconds: number;
    duration_seconds: number;
    speed: number;
  }) {
    setBusyAction(spec.scenario_id ?? "custom");
    setErrorBanner(null);
    setSelectedWindowKey(null);
    setOffsetSeconds(spec.start_offset_seconds);
    setDurationSeconds(spec.duration_seconds);
    setSpeed(spec.speed);
    try {
      const response = await fetch(`${DEVICE_API}/devices/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject_id: selectedSubject,
          start_offset_seconds: spec.start_offset_seconds,
          duration_seconds: spec.duration_seconds,
          speed: spec.speed,
          scenario_id: spec.scenario_id ?? null,
          replace_running: true,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.detail ?? "Không khởi chạy được phiên phát cảm biến.");
      }
      await refreshData();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "Lỗi kết nối Device Manager API.");
    } finally {
      setBusyAction(null);
    }
  }

  async function stopCurrentStream() {
    setBusyAction("stop");
    setErrorBanner(null);
    try {
      const response = await fetch(`${DEVICE_API}/devices/${selectedSubject}/stop`, {
        method: "POST",
      });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.detail ?? "Không dừng được phiên phát.");
      }
      await refreshData();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "Không dừng được thiết bị.");
    } finally {
      setBusyAction(null);
    }
  }

  async function submitFeedback(windowStart: string, verdict: "ACCURATE" | "FALSE_ALARM") {
    setBusyAction(`fb-${verdict}`);
    try {
      const note =
        verdict === "ACCURATE"
          ? "Người đeo xác nhận đúng cảm nhận thực tế"
          : "Người đeo báo nhầm (vận động / yếu tố ngoại cảnh)";
      const res = await fetch(`${DEVICE_API}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject_id: selectedSubject,
          window_start: windowStart,
          verdict,
          note,
        }),
      });
      if (res.ok) {
        await refreshData();
      }
    } finally {
      setBusyAction(null);
    }
  }

  async function activateModelVersion(version: string) {
    setBusyAction(`model-${version}`);
    setErrorBanner(null);
    try {
      const res = await fetch(`${REGISTRY_API}/models/${version}/activate`, {
        method: "PUT",
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.detail ?? "Không đổi được phiên bản model.");
      }
      await refreshData();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : "Lỗi gọi Model Registry.");
    } finally {
      setBusyAction(null);
    }
  }

  // Breathing phase label (4s inhale - 4s hold - 6s exhale = 14s cycle -> ~4.3 breaths/min vagal tone stimulation)
  const breathPhase =
    breathTick < 4
      ? { title: "Hít vào chậm bằng mũi", remain: 4 - breathTick }
      : breathTick < 8
        ? { title: "Giữ hơi nhẹ nhàng", remain: 8 - breathTick }
        : { title: "Thở ra từ từ bằng miệng", remain: 14 - breathTick };

  return (
    <main className="shell">
      {/* HEADER */}
      <header className="topbar">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h1 className="brand-title">WESAD Pulse &amp; Stress Companion</h1>
            <span className={backendMode === "live_stack" ? "pill pill-calm" : "pill pill-motion"}>
              <span
                className="live-dot"
                style={{
                  background: backendMode === "live_stack" ? "var(--teal)" : "var(--sky)",
                }}
              />
              {backendMode === "live_stack"
                ? "Cụm Live: Kafka · Spark · PostgreSQL"
                : "Chế độ Trình diễn Trực tiếp (Real RF + Mô phỏng E4)"}
            </span>
          </div>
          <p className="brand-sub">
            Theo dõi nhịp tim (BPM), biến thiên nhịp tim (HRV), phản ứng mồ hôi da (EDA) và phát hiện căng thẳng kéo dài theo thời gian thực
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12.5, color: "var(--muted)", whiteSpace: "nowrap" }}>
              Người đeo (Thiết bị):
            </span>
            <select
              value={selectedSubject}
              onChange={(e) => {
                setSelectedSubject(e.target.value);
                setSelectedWindowKey(null);
              }}
              style={{ width: 118, fontWeight: 600 }}
            >
              {subjects.map((subj) => (
                <option key={subj} value={subj}>
                  {subj === "S4" ? "S4 (Held-out)" : subj}
                </option>
              ))}
            </select>
          </div>

          <nav className="tab-bar" aria-label="Chế độ hiển thị">
            <button
              type="button"
              className={`tab-btn ${activeTab === "user" ? "active" : ""}`}
              onClick={() => setActiveTab("user")}
            >
              Theo dõi Sức khỏe &amp; Cảnh báo
            </button>
            <button
              type="button"
              className={`tab-btn ${activeTab === "ops" ? "active" : ""}`}
              onClick={() => setActiveTab("ops")}
            >
              Vận hành Pipeline &amp; Model ({activeModel?.version ?? "local"})
            </button>
          </nav>
        </div>
      </header>

      {errorBanner && (
        <div
          className="card"
          style={{
            marginTop: 14,
            borderColor: "rgba(235, 94, 77, 0.6)",
            background: "var(--red-soft)",
            color: "#ffb4ab",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
          }}
        >
          <span>{errorBanner}</span>
          <button type="button" onClick={() => setErrorBanner(null)}>
            Đóng
          </button>
        </div>
      )}

      {/* ==================== TAB 1: USER-FACING HEALTH COMPANION ==================== */}
      {activeTab === "user" && (
        <div style={{ display: "grid", gap: 14, marginTop: 16 }}>
          {/* 1-CLICK SCENARIO LAUNCHER */}
          <section className="card" style={{ padding: "14px 16px" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 10,
                flexWrap: "wrap",
                marginBottom: 12,
              }}
            >
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 700 }}>
                  Kịch bản tình huống sinh lý thực tế (1-Click Replay cho {selectedSubject})
                </div>
                <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
                  Chọn tình huống để phát luồng cảm biến cổ tay Empatica E4 qua mô hình Random Forest &amp; cửa sổ trượt 10s/30s
                </div>
              </div>
              {isStreaming && (
                <button
                  type="button"
                  className="btn-danger"
                  disabled={busyAction === "stop"}
                  onClick={() => void stopCurrentStream()}
                >
                  ■ Dừng phát luồng đang chạy
                </button>
              )}
            </div>

            <div className="scenario-grid">
              {scenarios.map((sc) => {
                const isCurrent =
                  currentDevice?.scenario_id === sc.id && isStreaming;
                const badgeClass =
                  sc.tone === "stress"
                    ? "pill pill-stress"
                    : sc.tone === "motion"
                      ? "pill pill-motion"
                      : sc.tone === "transition"
                        ? "pill pill-warn"
                        : "pill pill-calm";
                return (
                  <div
                    key={sc.id}
                    style={{
                      background: "var(--panel-2)",
                      border: `1px solid ${isCurrent ? "var(--teal)" : "var(--border)"}`,
                      borderRadius: 9,
                      padding: 12,
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "space-between",
                      gap: 10,
                    }}
                  >
                    <div>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: 6,
                          marginBottom: 6,
                        }}
                      >
                        <span className={badgeClass}>{sc.badge}</span>
                        <span style={{ fontSize: 11, color: "var(--muted)" }}>
                          {Math.round(sc.duration_seconds / 60)} phút · {sc.speed}×
                        </span>
                      </div>
                      <div style={{ fontWeight: 650, fontSize: 13.5, marginBottom: 5 }}>
                        {sc.title}
                      </div>
                      <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.45 }}>
                        {sc.description}
                      </div>
                    </div>

                    <div style={{ display: "grid", gap: 8 }}>
                      <div
                        style={{
                          fontSize: 11.5,
                          color: "#bfd0ca",
                          paddingTop: 6,
                          borderTop: "1px solid var(--border)",
                        }}
                      >
                        Kỳ vọng: {sc.expected_outcome}
                      </div>
                      <button
                        type="button"
                        className={isCurrent ? "" : "btn-primary"}
                        disabled={busyAction !== null}
                        onClick={() =>
                          void launchScenario({
                            scenario_id: sc.id,
                            start_offset_seconds: sc.start_offset_seconds,
                            duration_seconds: sc.duration_seconds,
                            speed: sc.speed,
                          })
                        }
                      >
                        {isCurrent
                          ? "● Đang phát trực tiếp..."
                          : `▶ Phát kịch bản (${sc.duration_seconds}s)`}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* CLINICAL STATUS & SUSTAINED ALERT BANNER */}
          {summary && (
            <section
              className="card"
              style={{
                borderLeft: `4px solid ${
                  summary.status === "SUSTAINED_STRESS"
                    ? "var(--red)"
                    : summary.status === "ATTENTION"
                      ? "var(--amber)"
                      : summary.status === "PHYSICAL_ACTIVITY"
                        ? "var(--sky)"
                        : "var(--teal)"
                }`,
                background:
                  summary.status === "SUSTAINED_STRESS"
                    ? "linear-gradient(90deg, rgba(235,94,77,0.13) 0%, var(--panel) 65%)"
                    : summary.status === "PHYSICAL_ACTIVITY"
                      ? "linear-gradient(90deg, rgba(75,163,227,0.12) 0%, var(--panel) 65%)"
                      : summary.status === "ATTENTION"
                        ? "linear-gradient(90deg, rgba(224,166,58,0.12) 0%, var(--panel) 65%)"
                        : "linear-gradient(90deg, rgba(56,178,154,0.11) 0%, var(--panel) 65%)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  gap: 16,
                  flexWrap: "wrap",
                }}
              >
                <div style={{ flex: "1 1 520px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span
                      className={
                        summary.status === "SUSTAINED_STRESS"
                          ? "pill pill-stress"
                          : summary.status === "ATTENTION"
                            ? "pill pill-warn"
                            : summary.status === "PHYSICAL_ACTIVITY"
                              ? "pill pill-motion"
                              : "pill pill-calm"
                      }
                    >
                      {summary.status === "SUSTAINED_STRESS"
                        ? "CẢNH BÁO CĂNG THẲNG KÉO DÀI"
                        : summary.status === "ATTENTION"
                          ? "THEO DÕI SỚM"
                          : summary.status === "PHYSICAL_ACTIVITY"
                            ? "BỐI CẢNH VẬN ĐỘNG"
                            : "CÂN BẰNG SINH LÝ"}
                    </span>
                    {summary.consecutive_stress_seconds > 0 && (
                      <span style={{ fontSize: 12, color: "var(--muted)" }}>
                        Chuỗi liên tiếp: <strong>{summary.consecutive_stress_windows}</strong> cửa sổ (
                        {summary.consecutive_stress_seconds}s)
                      </span>
                    )}
                    {summary.recovery_seconds !== null && (
                      <span className="pill pill-calm">
                        Thời gian hồi phục: {summary.recovery_seconds} giây
                      </span>
                    )}
                  </div>

                  <h2 style={{ margin: "8px 0 5px", fontSize: 18, fontWeight: 700 }}>
                    {summary.headline}
                  </h2>
                  <p style={{ margin: 0, fontSize: 13.5, color: "#cfe0da", lineHeight: 1.5 }}>
                    {summary.recommendation}
                  </p>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <button
                    type="button"
                    className={breathingOpen ? "" : "btn-primary"}
                    onClick={() => {
                      setBreathTick(0);
                      setBreathingOpen((v) => !v);
                    }}
                  >
                    {breathingOpen ? "Ẩn nhịp thở hướng dẫn" : "Mở bài thở hạ nhịp tim (4-4-6)"}
                  </button>
                </div>
              </div>

              {breathingOpen && (
                <div
                  style={{
                    marginTop: 14,
                    padding: "12px 16px",
                    borderRadius: 9,
                    background: "rgba(8, 14, 12, 0.72)",
                    border: "1px solid var(--border-strong)",
                    display: "flex",
                    alignItems: "center",
                    gap: 18,
                    flexWrap: "wrap",
                  }}
                >
                  <div className="breath-orb" />
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: "#7cead4" }}>
                      {breathPhase.title} — còn {breathPhase.remain}s
                    </div>
                    <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 3 }}>
                      Chu kỳ 14 giây (~4.3 nhịp/phút) kích hoạt dây thần kinh phế vị, giúp tăng chỉ số HRV (RMSSD) và đưa nhịp tim lúc nghỉ về mức nền sau 60–90 giây.
                    </div>
                  </div>
                </div>
              )}
            </section>
          )}

          {/* 4 HUMAN-CENTRIC VITAL SIGN CARDS */}
          <section className="vital-grid">
            {/* Card 1: Heart Rate */}
            <div className="card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600 }}>
                  NHỊP TIM HIỆN TẠI (HR)
                </span>
                <span className={fmtAnomalyVi(summary?.heart_anomaly ?? "NONE").cls}>
                  {fmtAnomalyVi(summary?.heart_anomaly ?? "NONE").label}
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 10 }}>
                <span style={{ fontSize: 32, fontWeight: 750 }}>
                  {summary?.latest_hr_bpm !== null && summary?.latest_hr_bpm !== undefined
                    ? summary.latest_hr_bpm.toFixed(0)
                    : "—"}
                </span>
                <span style={{ fontSize: 14, color: "var(--muted)" }}>BPM</span>
                {summary?.hr_delta_bpm !== null && summary?.hr_delta_bpm !== undefined && (
                  <span
                    style={{
                      marginLeft: "auto",
                      fontSize: 12.5,
                      fontWeight: 600,
                      color:
                        summary.hr_delta_bpm >= 15
                          ? "#ff9c90"
                          : summary.hr_delta_bpm <= -5
                            ? "#6ee7ce"
                            : "var(--muted)",
                    }}
                  >
                    {summary.hr_delta_bpm >= 0 ? `+${summary.hr_delta_bpm.toFixed(0)}` : summary.hr_delta_bpm.toFixed(0)}{" "}
                    BPM vs nền ({summary.baseline_hr_bpm?.toFixed(0) ?? 73})
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 8 }}>
                Nguồn: Sóng mạch quang học BVP 64 Hz &amp; luồng tổng hợp Spark 10s
              </div>
            </div>

            {/* Card 2: HRV RMSSD */}
            <div className="card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600 }}>
                  BIẾN THIÊN NHỊP TIM (HRV)
                </span>
                <span
                  className={
                    (summary?.latest_hrv_rmssd_ms ?? 35) < 22
                      ? "pill pill-stress"
                      : (summary?.latest_hrv_rmssd_ms ?? 35) < 30
                        ? "pill pill-warn"
                        : "pill pill-calm"
                  }
                >
                  {(summary?.latest_hrv_rmssd_ms ?? 35) < 22
                    ? "Giao cảm căng"
                    : (summary?.latest_hrv_rmssd_ms ?? 35) < 30
                      ? "Trung bình"
                      : "Phục hồi tốt"}
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 10 }}>
                <span style={{ fontSize: 32, fontWeight: 750 }}>
                  {summary?.latest_hrv_rmssd_ms !== null && summary?.latest_hrv_rmssd_ms !== undefined
                    ? summary.latest_hrv_rmssd_ms.toFixed(0)
                    : "—"}
                </span>
                <span style={{ fontSize: 14, color: "var(--muted)" }}>ms (RMSSD)</span>
              </div>
              <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 8 }}>
                HRV cao (&gt; 30 ms) biểu thị thư giãn; tụt thấp (&lt; 22 ms) báo hiệu cơ thể đang căng thẳng
              </div>
            </div>

            {/* Card 3: Composite Stress Load */}
            <div className="card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600 }}>
                  CHỈ SỐ CĂNG THẲNG (0–100)
                </span>
                <span style={{ fontSize: 12, color: "var(--muted)" }}>
                  AI RF:{" "}
                  <strong>
                    {summary?.latest_rf_score !== null && summary?.latest_rf_score !== undefined
                      ? `${(summary.latest_rf_score * 100).toFixed(0)}%`
                      : "—"}
                  </strong>
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 10 }}>
                <span
                  style={{
                    fontSize: 32,
                    fontWeight: 750,
                    color:
                      (summary?.latest_stress_load ?? 0) >= 65
                        ? "#ff8f82"
                        : (summary?.latest_stress_load ?? 0) >= 45
                          ? "#f6cb72"
                          : "#6ee7ce",
                  }}
                >
                  {summary?.latest_stress_load ?? "—"}
                </span>
                <span style={{ fontSize: 14, color: "var(--muted)" }}>/ 100</span>
                <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--muted)" }}>
                  Tỷ lệ stress phiên: <strong>{summary?.stress_ratio_pct ?? 0}%</strong>
                </span>
              </div>
              <div
                style={{
                  marginTop: 9,
                  height: 6,
                  borderRadius: 999,
                  background: "#0a100e",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${Math.min(100, Math.max(4, summary?.latest_stress_load ?? 0))}%`,
                    background:
                      (summary?.latest_stress_load ?? 0) >= 65
                        ? "var(--red)"
                        : (summary?.latest_stress_load ?? 0) >= 45
                          ? "var(--amber)"
                          : "var(--teal)",
                    transition: "width 240ms ease",
                  }}
                />
              </div>
            </div>

            {/* Card 4: Electrodermal + Skin Temp + Motion */}
            <div className="card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600 }}>
                  MỒ HÔI DA &amp; VẬN ĐỘNG
                </span>
                <span className={fmtActivityVi(summary?.activity_state ?? "RESTING").cls}>
                  {fmtActivityVi(summary?.activity_state ?? "RESTING").label}
                </span>
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  gap: 10,
                  marginTop: 10,
                }}
              >
                <div>
                  <span style={{ fontSize: 28, fontWeight: 750 }}>
                    {summary?.latest_eda_us !== null && summary?.latest_eda_us !== undefined
                      ? summary.latest_eda_us.toFixed(2)
                      : "—"}
                  </span>
                  <span style={{ fontSize: 13, color: "var(--muted)", marginLeft: 5 }}>µS EDA</span>
                </div>
                <div style={{ textAlign: "right" }}>
                  <span style={{ fontSize: 20, fontWeight: 700 }}>
                    {summary?.latest_temp_c !== null && summary?.latest_temp_c !== undefined
                      ? `${summary.latest_temp_c.toFixed(1)} °C`
                      : "—"}
                  </span>
                  <div style={{ fontSize: 11, color: "var(--muted)" }}>Nhiệt độ cổ tay</div>
                </div>
              </div>
              <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 6 }}>
                Cửa sổ bất thường nhịp tim: <strong>{summary?.anomaly_windows_count ?? 0}</strong> · Spark 10s:{" "}
                <strong>{summary?.spark_windows_count ?? 0}</strong> điểm
              </div>
            </div>
          </section>

          {/* DUAL-LAYER INTERACTIVE TIMELINE CHART (SPARK 10S + EDGE 30S) */}
          <section className="card">
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
                marginBottom: 12,
              }}
            >
              <div>
                <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
                  Biểu đồ Sinh lý Đa tốc độ: Luồng Spark 10 giây &amp; Vùng phân loại AI Edge 30 giây
                </h2>
                <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 3 }}>
                  Dải nền đỏ/xanh = Quyết định AI mỗi 30s (<code>stress_predictions</code>) · Đường nét liền = Chỉ số sinh tồn tổng hợp mỗi 10s bởi Spark (<code>sensor_window_aggregates</code>). Nhấp vào dải 30s bất kỳ để xem giải thích chi tiết.
                </div>
              </div>

              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {(
                  [
                    ["hr", "Nhịp tim (BPM)"],
                    ["eda", "Dẫn điện da (µS)"],
                    ["temp", "Nhiệt độ (°C)"],
                    ["load", "Chỉ số Stress (0–100)"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className={chartMetric === key ? "btn-primary" : ""}
                    style={{ padding: "6px 11px", fontSize: 12 }}
                    onClick={() => setChartMetric(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <DualTimelineChart
              predictions={predictions}
              sparkSeries={sparkSeries}
              metric={chartMetric}
              baselineHr={summary?.baseline_hr_bpm ?? 72}
              selectedWindowStart={selectedWindow?.window_start ?? null}
              onSelectWindow={(ws) => setSelectedWindowKey(ws)}
            />
          </section>

          {/* EXPLAINABILITY INSPECTOR + HUMAN-CENTRIC WINDOW HISTORY */}
          <section className="split-grid">
            {/* Left: Selected Window Explainability + Feedback + Global Feature Importance */}
            <div style={{ display: "grid", gap: 14, alignContent: "start" }}>
              <div className="card">
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 10,
                  }}
                >
                  <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>
                    Giải thích sinh lý cửa sổ đang chọn
                  </h3>
                  {selectedWindow && (
                    <span
                      className={
                        selectedWindow.prediction === "STRESS" ? "pill pill-stress" : "pill pill-calm"
                      }
                    >
                      {selectedWindow.prediction === "STRESS" ? "STRESS (Căng thẳng)" : "ỔN ĐỊNH"}
                    </span>
                  )}
                </div>

                {!selectedWindow ? (
                  <p style={{ color: "var(--muted)", fontSize: 13, margin: 0 }}>
                    Chưa có cửa sổ dự đoán. Hãy nhấn một kịch bản ở trên để bắt đầu.
                  </p>
                ) : (
                  <div style={{ display: "grid", gap: 12 }}>
                    <div
                      style={{
                        fontSize: 12.5,
                        color: "var(--muted)",
                        display: "flex",
                        justifyContent: "space-between",
                        flexWrap: "wrap",
                        gap: 6,
                      }}
                    >
                      <span>
                        Khung giờ: <code>{fmtClock(selectedWindow.window_start)}</code> –{" "}
                        <code>{fmtClock(selectedWindow.window_end)}</code> UTC
                      </span>
                      <span>
                        Model: <code>{selectedWindow.model_version ?? selectedWindow.model_file}</code> · RF{" "}
                        <strong>{(selectedWindow.model_score_stress * 100).toFixed(1)}%</strong>
                      </span>
                    </div>

                    {/* Reason codes list */}
                    <div style={{ display: "grid", gap: 8 }}>
                      {(selectedWindow.vitals.reason_codes ?? []).map((rc) => (
                        <div
                          key={rc.code}
                          style={{
                            padding: "10px 12px",
                            borderRadius: 8,
                            background: "var(--panel-2)",
                            border: `1px solid ${
                              rc.severity === "high"
                                ? "rgba(235,94,77,0.45)"
                                : rc.severity === "medium"
                                  ? "rgba(224,166,58,0.45)"
                                  : rc.severity === "info"
                                    ? "rgba(75,163,227,0.45)"
                                    : "var(--border)"
                            }`,
                          }}
                        >
                          <div style={{ fontWeight: 650, fontSize: 13, marginBottom: 3 }}>
                            {rc.label}
                          </div>
                          <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.45 }}>
                            {rc.detail}
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Human-in-the-loop Feedback */}
                    <div
                      style={{
                        paddingTop: 10,
                        borderTop: "1px solid var(--border)",
                        display: "grid",
                        gap: 8,
                      }}
                    >
                      <div style={{ fontSize: 12, color: "var(--muted)" }}>
                        Xác nhận thực tế từ người đeo (lưu vào <code>prediction_feedback</code>):
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button
                          type="button"
                          className={
                            selectedWindow.feedback?.verdict === "ACCURATE" ? "btn-primary" : ""
                          }
                          disabled={busyAction !== null}
                          onClick={() =>
                            void submitFeedback(selectedWindow.window_start, "ACCURATE")
                          }
                        >
                          ✓ Đúng với cảm nhận
                        </button>
                        <button
                          type="button"
                          className={
                            selectedWindow.feedback?.verdict === "FALSE_ALARM" ? "btn-danger" : ""
                          }
                          disabled={busyAction !== null}
                          onClick={() =>
                            void submitFeedback(selectedWindow.window_start, "FALSE_ALARM")
                          }
                        >
                          ✕ Báo nhầm (đang vận động / cà phê)
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Global Feature Group Importance */}
              <div className="card">
                <h3 style={{ margin: "0 0 6px", fontSize: 14, fontWeight: 700 }}>
                  Trọng số đóng góp cảm biến trong mô hình Random Forest
                </h3>
                <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--muted)" }}>
                  Tổng hợp từ 300 cây quyết định trên 16 đặc trưng miền thời gian cổ tay WESAD
                </p>
                <div style={{ display: "grid", gap: 9 }}>
                  {FEATURE_GROUP_IMPORTANCE.map((item) => (
                    <div key={item.name}>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          fontSize: 12,
                          marginBottom: 4,
                        }}
                      >
                        <span>{item.name}</span>
                        <strong>{item.pct}%</strong>
                      </div>
                      <div
                        style={{
                          height: 6,
                          borderRadius: 999,
                          background: "#0a100e",
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            width: `${item.pct}%`,
                            height: "100%",
                            background: item.color,
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Right: Human-meaningful 30s Window History Table */}
            <div className="card" style={{ overflowX: "auto" }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 10,
                }}
              >
                <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>
                  Nhật ký diễn biến các cửa sổ 30 giây ({predictions.length} cửa sổ)
                </h3>
                <span style={{ fontSize: 12, color: "var(--muted)" }}>
                  Nhấp vào một dòng để xem phân tích chi tiết
                </span>
              </div>

              {predictions.length === 0 ? (
                <p style={{ color: "var(--muted)", fontSize: 13 }}>
                  Chưa có dữ liệu dự đoán cho {selectedSubject}.
                </p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Thời gian (UTC)</th>
                      <th>Kết luận</th>
                      <th>Chỉ số Stress</th>
                      <th>Nhịp tim &amp; HRV</th>
                      <th>EDA &amp; Nhiệt độ</th>
                      <th>Vận động</th>
                      <th>Giải thích chính</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...predictions].reverse().map((row) => {
                      const v = row.vitals;
                      const isSel = selectedWindow?.window_start === row.window_start;
                      const topReason = v.reason_codes?.[0]?.label ?? "—";
                      return (
                        <tr
                          key={row.window_start}
                          className={`selectable-row ${isSel ? "selected-row" : ""}`}
                          onClick={() => setSelectedWindowKey(row.window_start)}
                        >
                          <td>
                            <code>
                              {fmtClock(row.window_start)}–{fmtClock(row.window_end)}
                            </code>
                          </td>
                          <td>
                            <span
                              className={
                                row.prediction === "STRESS" ? "pill pill-stress" : "pill pill-calm"
                              }
                            >
                              {row.prediction === "STRESS" ? "STRESS" : "ỔN ĐỊNH"}
                            </span>
                            {row.feedback && (
                              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 3 }}>
                                {row.feedback.verdict === "ACCURATE"
                                  ? "✓ Đã xác nhận đúng"
                                  : "✕ Đánh dấu báo nhầm"}
                              </div>
                            )}
                          </td>
                          <td>
                            <strong>{v.stress_load ?? "—"}/100</strong>
                            <div style={{ fontSize: 11, color: "var(--muted)" }}>
                              RF {(row.model_score_stress * 100).toFixed(0)}%
                            </div>
                          </td>
                          <td>
                            <strong>
                              {v.hr_bpm !== null && v.hr_bpm !== undefined
                                ? `${v.hr_bpm.toFixed(0)} BPM`
                                : "—"}
                            </strong>
                            <div style={{ fontSize: 11, color: "var(--muted)" }}>
                              HRV {v.hrv_rmssd_ms !== null && v.hrv_rmssd_ms !== undefined ? `${v.hrv_rmssd_ms.toFixed(0)} ms` : "—"}
                            </div>
                          </td>
                          <td>
                            <span>
                              {v.eda_mean_us !== null && v.eda_mean_us !== undefined
                                ? `${v.eda_mean_us.toFixed(2)} µS`
                                : "—"}
                            </span>
                            <div style={{ fontSize: 11, color: "var(--muted)" }}>
                              {v.temp_mean_c !== null && v.temp_mean_c !== undefined
                                ? `${v.temp_mean_c.toFixed(1)} °C`
                                : "—"}
                            </div>
                          </td>
                          <td>
                            <span className={fmtActivityVi(v.activity_state).cls}>
                              {fmtActivityVi(v.activity_state).label}
                            </span>
                          </td>
                          <td style={{ maxWidth: 230, color: "#d5e4df" }}>{topReason}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </div>
      )}

      {/* ==================== TAB 2: BIG DATA PIPELINE & MODEL REGISTRY OPS ==================== */}
      {activeTab === "ops" && (
        <div style={{ display: "grid", gap: 14, marginTop: 16 }}>
          {/* Architecture Strip */}
          <section className="card" style={{ padding: "13px 16px" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 10,
              }}
            >
              <div style={{ fontSize: 13 }}>
                <strong>Kiến trúc Luồng Kép (Dual-Speed Streaming):</strong>{" "}
                <span style={{ color: "var(--muted)" }}>
                  Empatica E4 Replay (105 mẫu/giây) → <code>Kafka wearable.sensor.v1</code> →{" "}
                  <strong style={{ color: "#7cead4" }}>
                    [Nhánh 1: Spark Structured Streaming cửa sổ 10s → sensor_window_aggregates]
                  </strong>{" "}
                  +{" "}
                  <strong style={{ color: "#8fd0ff" }}>
                    [Nhánh 2: Edge Consumer 30s + Hot-Swap RF → stress_predictions]
                  </strong>{" "}
                  → PostgreSQL · Prometheus · Grafana
                </span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <span className={apiOnline ? "pill pill-calm" : "pill pill-stress"}>
                  Device API: {apiOnline ? "ONLINE" : "OFFLINE"}
                </span>
                <span className={registryOnline ? "pill pill-calm" : "pill pill-warn"}>
                  Model Registry: {registryOnline ? "ONLINE" : "OFFLINE"}
                </span>
              </div>
            </div>
          </section>

          <div className="ops-grid">
            {/* Left: Custom Replay Controls & Model Registry */}
            <div style={{ display: "grid", gap: 14, alignContent: "start" }}>
              <section className="card">
                <h2 style={{ margin: "0 0 12px", fontSize: 16, fontWeight: 700 }}>
                  Điều khiển tham số phát luồng tùy chỉnh
                </h2>
                <div style={{ display: "grid", gap: 10 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <label style={{ display: "grid", gap: 5, fontSize: 12, color: "var(--muted)" }}>
                      Offset bắt đầu (giây)
                      <input
                        type="number"
                        min={0}
                        step={30}
                        value={offsetSeconds}
                        onChange={(e) => setOffsetSeconds(Number(e.target.value))}
                      />
                    </label>
                    <label style={{ display: "grid", gap: 5, fontSize: 12, color: "var(--muted)" }}>
                      Thời lượng phát (giây)
                      <input
                        type="number"
                        min={30}
                        max={1800}
                        step={30}
                        value={durationSeconds}
                        onChange={(e) => setDurationSeconds(Number(e.target.value))}
                      />
                    </label>
                  </div>

                  <label style={{ display: "grid", gap: 5, fontSize: 12, color: "var(--muted)" }}>
                    Hệ số tăng tốc luồng (1× – 120×)
                    <input
                      type="number"
                      min={1}
                      max={120}
                      value={speed}
                      onChange={(e) => setSpeed(Number(e.target.value))}
                    />
                  </label>

                  <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                    <button
                      type="button"
                      className="btn-primary"
                      style={{ flex: 1 }}
                      disabled={busyAction !== null}
                      onClick={() =>
                        void launchScenario({
                          start_offset_seconds: offsetSeconds,
                          duration_seconds: durationSeconds,
                          speed,
                        })
                      }
                    >
                      ▶ Khởi chạy Producer + Edge
                    </button>
                    <button
                      type="button"
                      className="btn-danger"
                      disabled={!isStreaming || busyAction !== null}
                      onClick={() => void stopCurrentStream()}
                    >
                      ■ Dừng
                    </button>
                  </div>
                </div>
              </section>

              {/* Model Registry Hot-Swap */}
              <section className="card">
                <h2 style={{ margin: "0 0 6px", fontSize: 16, fontWeight: 700 }}>
                  Model Registry &amp; Hot-Swap không dừng luồng
                </h2>
                <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--muted)" }}>
                  Edge tự động kiểm tra <code>/models/active</code> mỗi 5s, đối chiếu SHA-256 và nạp nóng mô hình mới
                </p>

                {models.length === 0 ? (
                  <p style={{ fontSize: 12.5, color: "var(--muted)" }}>
                    Chưa có phiên bản model nào trong Registry (dùng <code>scripts/publish_model.py</code> để đăng ký).
                  </p>
                ) : (
                  <div style={{ display: "grid", gap: 10 }}>
                    {models.map((m) => {
                      const losoF1 = m.metrics?.loso_mean_metrics?.stress_f1;
                      const s4F1 = m.metrics?.heldout_metrics?.S4?.stress_f1;
                      const s4Acc = m.metrics?.heldout_metrics?.S4?.accuracy;
                      return (
                        <div
                          key={m.version}
                          style={{
                            padding: 12,
                            borderRadius: 8,
                            background: "var(--panel-2)",
                            border: `1px solid ${m.is_active ? "var(--teal)" : "var(--border)"}`,
                            display: "grid",
                            gap: 6,
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                            }}
                          >
                            <div>
                              <strong style={{ fontSize: 14 }}>{m.version}</strong>{" "}
                              <code style={{ fontSize: 11.5, color: "var(--muted)" }}>
                                ({m.model_file})
                              </code>
                            </div>
                            <button
                              type="button"
                              className={m.is_active ? "pill pill-calm" : ""}
                              disabled={m.is_active || busyAction !== null}
                              onClick={() => void activateModelVersion(m.version)}
                            >
                              {m.is_active ? "● Đang Active" : "Kích hoạt"}
                            </button>
                          </div>
                          <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
                            SHA-256: <code>{m.sha256.slice(0, 20)}…</code>
                          </div>
                          <div style={{ display: "flex", gap: 12, fontSize: 12, flexWrap: "wrap" }}>
                            {losoF1 !== undefined && (
                              <span>
                                LOSO F1: <strong>{(losoF1 * 100).toFixed(1)}%</strong>
                              </span>
                            )}
                            {s4F1 !== undefined && (
                              <span>
                                Held-out S4 F1: <strong>{(s4F1 * 100).toFixed(1)}%</strong>
                              </span>
                            )}
                            {s4Acc !== undefined && (
                              <span>
                                S4 Acc: <strong>{(s4Acc * 100).toFixed(1)}%</strong>
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>

            {/* Right: Live Process Logs + Spark 10s Micro-batch Feed */}
            <div style={{ display: "grid", gap: 14, alignContent: "start" }}>
              <section className="card">
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 10,
                    flexWrap: "wrap",
                    gap: 8,
                  }}
                >
                  <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
                    Nhật ký Tiến trình Trực tiếp ({selectedSubject})
                  </h2>
                  {currentDevice && (
                    <div style={{ display: "flex", gap: 8, fontSize: 12 }}>
                      <span className="pill">Producer: {currentDevice.producer_status}</span>
                      <span className="pill">Edge: {currentDevice.edge_status}</span>
                      <span className="pill">
                        Group: <code>{currentDevice.consumer_group}</code>
                      </span>
                    </div>
                  )}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <div>
                    <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 5 }}>
                      Kafka Producer (<code>produce_e4.py</code>)
                    </div>
                    <pre
                      style={{
                        margin: 0,
                        height: 170,
                        overflow: "auto",
                        padding: 10,
                        borderRadius: 8,
                        background: "#070b0a",
                        border: "1px solid var(--border)",
                        fontSize: 11.5,
                        color: "#b7ccc5",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {currentDevice?.producer_logs?.length
                        ? currentDevice.producer_logs.join("\n")
                        : "Chưa có tiến trình Producer trong phiên hiện tại."}
                    </pre>
                  </div>

                  <div>
                    <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 5 }}>
                      Edge Consumer &amp; Vitals (<code>edge_inference.py</code>)
                    </div>
                    <pre
                      style={{
                        margin: 0,
                        height: 170,
                        overflow: "auto",
                        padding: 10,
                        borderRadius: 8,
                        background: "#070b0a",
                        border: "1px solid var(--border)",
                        fontSize: 11.5,
                        color: "#b7ccc5",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {currentDevice?.edge_logs?.length
                        ? currentDevice.edge_logs.join("\n")
                        : "Chưa có tiến trình Edge trong phiên hiện tại."}
                    </pre>
                  </div>
                </div>
              </section>

              {/* Spark 10s Tumbling Window Aggregates Table */}
              <section className="card" style={{ overflowX: "auto" }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 10,
                  }}
                >
                  <div>
                    <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
                      Luồng Tổng hợp Spark Structured Streaming 10 giây (<code>sensor_window_aggregates</code>)
                    </h2>
                    <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
                      Watermark 15s · Cửa sổ trượt không chồng lấp 10s · Batch mới nhất:{" "}
                      <code>#{summary?.latest_spark_batch_id ?? "—"}</code>
                    </div>
                  </div>
                </div>

                {sparkSeries.length === 0 ? (
                  <p style={{ fontSize: 13, color: "var(--muted)" }}>
                    Chưa có bản ghi cửa sổ 10s trong <code>sensor_window_aggregates</code>.
                  </p>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>Cửa sổ 10s (UTC)</th>
                        <th>Spark Batch</th>
                        <th>HR trung bình</th>
                        <th>EDA trung bình</th>
                        <th>TEMP trung bình</th>
                        <th>Biên độ ACC</th>
                        <th>Tổng mẫu / 10s</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...sparkSeries]
                        .reverse()
                        .slice(0, 12)
                        .map((pt) => (
                          <tr key={pt.window_start_utc}>
                            <td>
                              <code>
                                {fmtClock(pt.window_start_utc)}–{fmtClock(pt.window_end_utc)}
                              </code>
                            </td>
                            <td>
                              <code>#{pt.spark_batch_id}</code>
                            </td>
                            <td>
                              {pt.hr_bpm !== null ? <strong>{pt.hr_bpm.toFixed(1)} BPM</strong> : "—"}
                            </td>
                            <td>{pt.eda_us !== null ? `${pt.eda_us.toFixed(3)} µS` : "—"}</td>
                            <td>{pt.temp_c !== null ? `${pt.temp_c.toFixed(2)} °C` : "—"}</td>
                            <td>{pt.acc_range !== null ? `${pt.acc_range.toFixed(1)} LSB` : "—"}</td>
                            <td>{pt.sample_count_total.toLocaleString()} mẫu</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                )}
              </section>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

/* ==================== SVG DUAL-SPEED CHART COMPONENT ==================== */

function DualTimelineChart({
  predictions,
  sparkSeries,
  metric,
  baselineHr,
  selectedWindowStart,
  onSelectWindow,
}: {
  predictions: PredictionWindow[];
  sparkSeries: SparkPoint[];
  metric: ChartMetric;
  baselineHr: number;
  selectedWindowStart: string | null;
  onSelectWindow: (windowStart: string) => void;
}) {
  if (predictions.length === 0 && sparkSeries.length === 0) {
    return (
      <div
        style={{
          height: 230,
          display: "grid",
          placeItems: "center",
          border: "1px dashed var(--border)",
          borderRadius: 8,
          color: "var(--muted)",
          fontSize: 13,
        }}
      >
        Chưa có dữ liệu chuỗi thời gian — hãy chọn một kịch bản ở trên để phát luồng cảm biến.
      </div>
    );
  }

  const width = 980;
  const height = 248;
  const padL = 52;
  const padR = 20;
  const padT = 18;
  const padB = 34;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const allTimes: number[] = [];
  for (const p of predictions) {
    allTimes.push(new Date(p.window_start).getTime(), new Date(p.window_end).getTime());
  }
  for (const s of sparkSeries) {
    allTimes.push(new Date(s.window_start_utc).getTime(), new Date(s.window_end_utc).getTime());
  }
  const minT = Math.min(...allTimes);
  const maxT = Math.max(minT + 10_000, ...allTimes);

  const xOf = (ms: number) => padL + ((ms - minT) / (maxT - minT)) * plotW;

  // Build metric series points from 10s Spark series (or 30s Edge vitals for Stress Load)
  const points: { t: number; v: number; label: string }[] = [];
  if (metric === "load") {
    for (const p of predictions) {
      const mid = (new Date(p.window_start).getTime() + new Date(p.window_end).getTime()) / 2;
      const val = p.vitals.stress_load ?? Math.round(p.model_score_stress * 100);
      points.push({ t: mid, v: val, label: `${val}/100` });
    }
  } else {
    for (const s of sparkSeries) {
      const mid =
        (new Date(s.window_start_utc).getTime() + new Date(s.window_end_utc).getTime()) / 2;
      const raw =
        metric === "hr" ? s.hr_bpm : metric === "eda" ? s.eda_us : s.temp_c;
      if (raw !== null && raw !== undefined && Number.isFinite(raw)) {
        points.push({ t: mid, v: raw, label: String(raw) });
      }
    }
    // Fallback to 30s vitals if Spark table is empty
    if (points.length === 0) {
      for (const p of predictions) {
        const mid = (new Date(p.window_start).getTime() + new Date(p.window_end).getTime()) / 2;
        const raw =
          metric === "hr"
            ? p.vitals.hr_bpm
            : metric === "eda"
              ? p.vitals.eda_mean_us
              : p.vitals.temp_mean_c;
        if (raw !== null && raw !== undefined && Number.isFinite(raw)) {
          points.push({ t: mid, v: raw, label: String(raw) });
        }
      }
    }
  }

  let yMin = 0;
  let yMax = 100;
  let unit = "";
  let lineColor = "#5eead4";

  if (metric === "hr") {
    const vals = points.map((p) => p.v).concat([baselineHr]);
    yMin = Math.floor(Math.min(58, ...vals) - 4);
    yMax = Math.ceil(Math.max(115, ...vals) + 6);
    unit = "BPM";
    lineColor = "#5eead4";
  } else if (metric === "eda") {
    const vals = points.map((p) => p.v);
    yMin = 0;
    yMax = Math.max(2.5, ...(vals.length ? vals : [2.5])) * 1.15;
    unit = "µS";
    lineColor = "#67c3ff";
  } else if (metric === "temp") {
    const vals = points.map((p) => p.v);
    yMin = Math.min(31.5, ...(vals.length ? vals : [31.5])) - 0.3;
    yMax = Math.max(34.2, ...(vals.length ? vals : [34.2])) + 0.3;
    unit = "°C";
    lineColor = "#f6cb72";
  } else {
    yMin = 0;
    yMax = 100;
    unit = "/100";
    lineColor = "#ff8f82";
  }

  const yOf = (val: number) => {
    const clamped = Math.max(yMin, Math.min(yMax, val));
    return padT + plotH - ((clamped - yMin) / Math.max(1e-6, yMax - yMin)) * plotH;
  };

  const polyPoints = points.map((pt) => `${xOf(pt.t).toFixed(1)},${yOf(pt.v).toFixed(1)}`).join(" ");
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => yMin + f * (yMax - yMin));

  return (
    <div style={{ width: "100%", overflowX: "auto" }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: "100%", minWidth: 680, height: "auto", display: "block" }}
        role="img"
        aria-label="Biểu đồ chuỗi thời gian nhịp tim và căng thẳng"
      >
        {/* 30s Edge AI Background Bands */}
        {predictions.map((pred) => {
          const x1 = xOf(new Date(pred.window_start).getTime());
          const x2 = xOf(new Date(pred.window_end).getTime());
          const w = Math.max(4, x2 - x1);
          const isStress = pred.prediction === "STRESS";
          const isMotion = pred.vitals.activity_state === "HIGH_ACTIVITY";
          const isSel = selectedWindowStart === pred.window_start;
          const fill = isStress
            ? "rgba(235, 94, 77, 0.20)"
            : isMotion
              ? "rgba(75, 163, 227, 0.14)"
              : "rgba(56, 178, 154, 0.07)";

          return (
            <g
              key={pred.window_start}
              style={{ cursor: "pointer" }}
              onClick={() => onSelectWindow(pred.window_start)}
            >
              <rect
                x={x1}
                y={padT}
                width={w}
                height={plotH}
                fill={fill}
                stroke={isSel ? "#edf4f1" : "rgba(255,255,255,0.06)"}
                strokeWidth={isSel ? 1.5 : 0.6}
              />
              <text
                x={x1 + w / 2}
                y={padT + 13}
                textAnchor="middle"
                fill={isStress ? "#ff9c90" : isMotion ? "#8fd0ff" : "#7fd8c5"}
                fontSize={9.5}
                fontWeight={700}
              >
                {isStress ? "STRESS" : isMotion ? "VẬN ĐỘNG" : "ỔN ĐỊNH"}
              </text>
            </g>
          );
        })}

        {/* Horizontal Y gridlines */}
        {yTicks.map((tv, idx) => {
          const yy = yOf(tv);
          return (
            <g key={idx}>
              <line
                x1={padL}
                y1={yy}
                x2={width - padR}
                y2={yy}
                stroke="rgba(255,255,255,0.07)"
                strokeDasharray="3 3"
              />
              <text
                x={padL - 8}
                y={yy + 4}
                textAnchor="end"
                fill="#93a7a0"
                fontSize={10.5}
              >
                {metric === "eda" || metric === "temp" ? tv.toFixed(1) : Math.round(tv)}
              </text>
            </g>
          );
        })}

        {/* Personal Baseline HR Reference Line */}
        {metric === "hr" && (
          <g>
            <line
              x1={padL}
              y1={yOf(baselineHr)}
              x2={width - padR}
              y2={yOf(baselineHr)}
              stroke="rgba(224, 166, 58, 0.7)"
              strokeWidth={1.2}
              strokeDasharray="5 4"
            />
            <text
              x={width - padR - 4}
              y={yOf(baselineHr) - 5}
              textAnchor="end"
              fill="#f6cb72"
              fontSize={10}
            >
              Mức nền nghỉ ({baselineHr.toFixed(0)} BPM)
            </text>
          </g>
        )}

        {/* 10s Spark Continuous Line + Dots */}
        {points.length > 1 && (
          <polyline
            fill="none"
            stroke={lineColor}
            strokeWidth={2.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            points={polyPoints}
          />
        )}

        {points.map((pt, idx) => (
          <circle
            key={idx}
            cx={xOf(pt.t)}
            cy={yOf(pt.v)}
            r={3.6}
            fill="#080c0b"
            stroke={lineColor}
            strokeWidth={2}
          >
            <title>{`${new Date(pt.t).toISOString().slice(11, 19)} UTC · ${pt.v.toFixed(1)} ${unit}`}</title>
          </circle>
        ))}

        {/* X-axis timestamps */}
        {predictions.map((pred, idx) => {
          if (predictions.length > 8 && idx % 2 !== 0 && idx !== predictions.length - 1) {
            return null;
          }
          const x = xOf(new Date(pred.window_start).getTime());
          return (
            <text
              key={`lbl-${pred.window_start}`}
              x={x + 2}
              y={height - 10}
              fill="#93a7a0"
              fontSize={10.5}
            >
              {fmtClock(pred.window_start)}
            </text>
          );
        })}
      </svg>
    </div>
  );
}
