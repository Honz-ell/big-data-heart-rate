import {
  buildExplainableReasons,
  buildHeroConclusion,
  buildSystemTelemetry,
  buildTeamOverviewData,
  DEFAULT_MODELS,
  DEMO_SCENARIOS,
  fmtClockShort,
  generateMockPersonalState,
  RawTeamSummaryPayload,
  scoreToZone,
  WESAD_SUBJECTS,
} from "./mockEngine";
import {
  ActivityLevel,
  Edge30sWindow,
  ModelVersionInfo,
  PersonalDashboardData,
  ScenarioId,
  Spark10sPoint,
  SystemTelemetryData,
  TeamOverviewData,
  TimelineEventMarker,
  ZoneState,
} from "./types";

const DEVICE_API = "/api/device";
const REGISTRY_API = "/api/registry";

interface RawPredictionRow {
  subject_id: string;
  window_start: string;
  window_end: string;
  prediction: "STRESS" | "NON_STRESS";
  model_score_stress: number;
  model_file: string;
  model_version: string | null;
  vitals?: {
    hr_bpm?: number | null;
    baseline_hr_bpm?: number | null;
    hr_delta_bpm?: number | null;
    hrv_rmssd_ms?: number | null;
    eda_mean_us?: number | null;
    temp_mean_c?: number | null;
    acc_activity_g?: number | null;
    activity_state?: ActivityLevel;
    stress_load?: number | null;
  };
  feedback?: {
    verdict: "ACCURATE" | "FALSE_ALARM";
    note: string;
  } | null;
}

interface RawSparkPoint {
  window_start_utc: string;
  window_end_utc: string;
  spark_batch_id: number;
  sample_count_total: number;
  hr_bpm: number | null;
  eda_us: number | null;
  temp_c: number | null;
  acc_mean: number | null;
  acc_range: number | null;
}

interface RawTimelineResponse {
  mode: "demo_replay" | "live_stack";
  subject_id: string;
  predictions: RawPredictionRow[];
  spark_series: RawSparkPoint[];
}

interface RawDeviceSession {
  subject_id: string;
  scenario_id?: string | null;
  speed: number;
  producer_status: string;
  edge_status: string;
  producer_logs?: string[];
  edge_logs?: string[];
}

interface RawRegistryModel {
  version: string;
  model_file: string;
  sha256: string;
  metrics?: {
    loso_mean_metrics?: {
      stress_f1?: number;
      stress_recall?: number;
    };
    heldout_metrics?: Record<string, { stress_f1?: number; stress_recall?: number }>;
  };
  is_active: boolean;
  created_at: string;
}

async function fetchJsonWithTimeout<T>(url: string, init?: RequestInit, timeoutMs = 10000): Promise<T> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) {
      let detail =
        res.status === 500 || res.status === 502
          ? "Chưa bật tiến trình uvicorn cổng 8001 (hoặc cổng 8001 đang bận)"
          : `HTTP ${res.status}`;
      try {
        const errBody = await res.json();
        if (errBody?.detail) detail = String(errBody.detail);
      } catch {
        // ignore parse error
      }
      throw new Error(detail);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === "AbortError" || err.message.includes("aborted"))
    ) {
      throw new Error(
        "Quá thời gian chờ phản hồi từ cổng 8001 — kiểm tra cửa sổ chạy uvicorn scripts.device_manager_api:app"
      );
    }
    throw err;
  } finally {
    clearTimeout(id);
  }
}

export interface AdapterFetchBundle {
  personal: PersonalDashboardData;
  team: TeamOverviewData;
  system: SystemTelemetryData;
  apiConnected: boolean;
  backendMode: "live_stack" | "demo_replay" | "client_mock";
  errorMessage: string | null;
}

export async function fetchDashboardBundle(params: {
  subjectId: string;
  scenarioId: ScenarioId;
  speed: number;
  forceMockMode: boolean;
  pausedLocally: boolean;
  mockVisibleWindows: number;
  mockStreamState: "running" | "paused" | "stopped" | "starting";
  mockActiveModel: string;
  localFeedbackMap: Record<string, { verdict: "ACCURATE" | "FALSE_ALARM"; note: string }>;
  tickSeed: number;
}): Promise<AdapterFetchBundle> {
  if (params.forceMockMode) {
    const personal = generateMockPersonalState({
      subjectId: params.subjectId,
      scenarioId: params.scenarioId,
      activeModelVersion: params.mockActiveModel,
      visibleWindowsCount: params.mockVisibleWindows,
      streamState: params.mockStreamState,
      connectionState: "mock_forced",
      feedbackMap: params.localFeedbackMap,
    });
    return {
      personal,
      team: buildTeamOverviewData(personal),
      system: buildSystemTelemetry({
        isStreaming: params.mockStreamState === "running",
        speed: params.speed,
        activeModelVersion: params.mockActiveModel,
        scenarioId: params.scenarioId,
        tickSeed: params.tickSeed,
      }),
      apiConnected: false,
      backendMode: "client_mock",
      errorMessage: null,
    };
  }

  try {
    const [timeline, devices, rawModels, telemetry, teamSummary] = await Promise.all([
      fetchJsonWithTimeout<RawTimelineResponse>(
        `${DEVICE_API}/devices/${encodeURIComponent(params.subjectId)}/timeline?limit=30`
      ),
      fetchJsonWithTimeout<RawDeviceSession[]>(`${DEVICE_API}/devices`).catch(() => []),
      fetchJsonWithTimeout<RawRegistryModel[]>(`${REGISTRY_API}/models`).catch(() => null),
      fetchJsonWithTimeout<{
        services?: SystemTelemetryData["services"];
        kafka_records_per_sec?: number;
        spark_processed_per_sec?: number;
        spark_batch_ms?: number;
        total_predictions?: number;
        total_spark_windows?: number;
      }>(`${DEVICE_API}/pipeline/telemetry`).catch(() => null),
      fetchJsonWithTimeout<RawTeamSummaryPayload>(`${DEVICE_API}/team/summary`).catch(() => null),
    ]);

    const mappedModels: ModelVersionInfo[] =
      rawModels && rawModels.length > 0
        ? rawModels.map((rm) => {
            const losoRecall = rm.metrics?.loso_mean_metrics?.stress_recall;
            const losoF1 = rm.metrics?.loso_mean_metrics?.stress_f1;
            const s4F1 = rm.metrics?.heldout_metrics?.S4?.stress_f1 ?? null;
            return {
              version: rm.version,
              modelFile: rm.model_file,
              sha256Short: rm.sha256.slice(0, 12),
              sha256Full: rm.sha256,
              stressRecall:
                losoRecall !== undefined
                  ? +(losoRecall * 100).toFixed(1)
                  : rm.version === "v1.1.0"
                    ? 68.5
                    : 60.0,
              stressF1:
                s4F1 !== null
                  ? +(s4F1 * 100).toFixed(1)
                  : losoF1 !== undefined
                    ? +(losoF1 * 100).toFixed(1)
                    : 56.9,
              heldoutS4F1: s4F1 !== null ? +(s4F1 * 100).toFixed(1) : null,
              releasedAt: rm.created_at ? rm.created_at.slice(0, 16).replace("T", " ") + " UTC" : "2026-11-21",
              isActive: rm.is_active,
              notes:
                s4F1 !== null
                  ? `Kiểm thử độc lập S4 F1 ${(s4F1 * 100).toFixed(1)}% · LOSO F1 ${((losoF1 ?? 0.569) * 100).toFixed(1)}%`
                  : `Đánh giá chéo 14 người đeo LOSO F1 ${((losoF1 ?? 0.569) * 100).toFixed(1)}%`,
            };
          })
        : DEFAULT_MODELS;

    const activeModelVersion =
      mappedModels.find((m) => m.isActive)?.version ?? params.mockActiveModel;

    const subjSession = devices.find((d) => d.subject_id === params.subjectId);
    let streamState: PersonalDashboardData["streamState"] = "stopped";
    if (params.pausedLocally) {
      streamState = "paused";
    } else if (
      subjSession &&
      (subjSession.producer_status === "starting" || subjSession.edge_status === "starting")
    ) {
      streamState = "starting";
    } else if (subjSession && subjSession.producer_status === "running") {
      streamState = "running";
    }

    const subjMeta = WESAD_SUBJECTS.find((s) => s.id === params.subjectId) ?? WESAD_SUBJECTS[0];

    // Map Spark 10s points
    const sparkSeries: Spark10sPoint[] = (timeline.spark_series ?? []).map((pt) => {
      const ms = Date.parse(pt.window_start_utc);
      return {
        window_start_utc: pt.window_start_utc,
        window_end_utc: pt.window_end_utc,
        clockLabel: fmtClockShort(pt.window_start_utc),
        timestampMs: Number.isNaN(ms) ? Date.now() : ms,
        hr_bpm: pt.hr_bpm !== null ? +Number(pt.hr_bpm).toFixed(1) : null,
        eda_us: pt.eda_us !== null ? +Number(pt.eda_us).toFixed(2) : null,
        temp_c: pt.temp_c !== null ? +Number(pt.temp_c).toFixed(2) : null,
        acc_g: pt.acc_range !== null ? +(Number(pt.acc_range) / 64).toFixed(3) : null,
        sample_count_total: pt.sample_count_total ?? 1058,
        spark_batch_id: pt.spark_batch_id ?? 1,
      };
    });

    // Map Edge 30s windows
    const events: TimelineEventMarker[] = [];
    let stressStreak = 0;
    let alertCount = 0;

    const edgeWindows: Edge30sWindow[] = (timeline.predictions ?? []).map((row, idx) => {
      const startMs = Date.parse(row.window_start);
      const endMs = Date.parse(row.window_end);
      const v = row.vitals ?? {};
      const activity: ActivityLevel = v.activity_state ?? "RESTING";
      const rawRf = Number(row.model_score_stress ?? 0);
      const eda = v.eda_mean_us !== undefined && v.eda_mean_us !== null ? Number(v.eda_mean_us) : null;
      const hr = v.hr_bpm !== undefined && v.hr_bpm !== null ? Number(v.hr_bpm) : null;
      const baseHr =
        v.baseline_hr_bpm !== undefined && v.baseline_hr_bpm !== null
          ? Number(v.baseline_hr_bpm)
          : subjMeta.baselineHr;
      const hrDelta =
        v.hr_delta_bpm !== undefined && v.hr_delta_bpm !== null
          ? Number(v.hr_delta_bpm)
          : hr !== null
            ? +(hr - baseHr).toFixed(1)
            : null;
      const hrv =
        v.hrv_rmssd_ms !== undefined && v.hrv_rmssd_ms !== null ? Number(v.hrv_rmssd_ms) : null;
      const temp =
        v.temp_mean_c !== undefined && v.temp_mean_c !== null ? Number(v.temp_mean_c) : null;
      const accG =
        v.acc_activity_g !== undefined && v.acc_activity_g !== null ? Number(v.acc_activity_g) : null;

      // Motion shield triggers when vigorous physical motion occurs without sympathetic EDA surge
      const motionShield =
        (activity === "HIGH_ACTIVITY" && (eda === null || eda < 2.1)) ||
        (params.scenarioId === "physical_activity_check" &&
          activity !== "RESTING" &&
          (hrDelta ?? 0) >= 12 &&
          (eda === null || eda < 1.9));

      const rawIndex =
        v.stress_load !== undefined && v.stress_load !== null
          ? Number(v.stress_load)
          : Math.round(rawRf * 100);
      const displayScore = motionShield ? Math.min(35, rawIndex) : rawIndex;
      const zone: ZoneState = motionShield ? "RELAXED" : scoreToZone(displayScore);
      const fb = row.feedback ?? params.localFeedbackMap[row.window_start] ?? null;

      if (zone === "STRESS") {
        stressStreak += 1;
        if (stressStreak === 1) {
          events.push({
            id: `onset-${idx}`,
            timestampMs: startMs,
            clockLabel: fmtClockShort(row.window_start),
            type: "STRESS_ONSET",
            label: "Bắt đầu căng thẳng",
          });
        }
        if (stressStreak === 2) {
          alertCount += 1;
          events.push({
            id: `alert-${idx}`,
            timestampMs: startMs + 10_000,
            clockLabel: fmtClockShort(row.window_start),
            type: "ALERT_SENT",
            label: "Đã gửi cảnh báo",
          });
        }
      } else {
        stressStreak = 0;
      }

      if (motionShield && !events.some((e) => e.type === "MOTION_SHIELD")) {
        events.push({
          id: `shield-${idx}`,
          timestampMs: startMs,
          clockLabel: fmtClockShort(row.window_start),
          type: "MOTION_SHIELD",
          label: "Chặn báo giả (vận động)",
        });
      }

      if (fb) {
        events.push({
          id: `fb-${idx}`,
          timestampMs: startMs + 15_000,
          clockLabel: fmtClockShort(row.window_start),
          type: "USER_FEEDBACK",
          label: fb.verdict === "ACCURATE" ? "Xác nhận: Đúng" : "Báo nhầm",
        });
      }

      const reasons = buildExplainableReasons({
        edaUs: eda,
        baselineEdaUs: subjMeta.baselineEda,
        hrBpm: hr,
        baselineHrBpm: baseHr,
        hrvMs: hrv,
        tempC: temp,
        activityState: activity,
        accG,
        motionShield,
        zone,
      });

      return {
        window_start: row.window_start,
        window_end: row.window_end,
        startMs,
        endMs,
        clockRange: `${fmtClockShort(row.window_start)}–${fmtClockShort(row.window_end)}`,
        prediction: row.prediction,
        rawStressScore: +rawRf.toFixed(3),
        displayStressIndex: displayScore,
        zone,
        motionShieldActive: motionShield,
        confidencePercent: Math.round(74 + Math.abs(rawRf - 0.5) * 48),
        modelVersion: row.model_version ?? activeModelVersion,
        hr_bpm: hr,
        baseline_hr_bpm: baseHr,
        hr_delta_bpm: hrDelta,
        hrv_rmssd_ms: hrv,
        eda_mean_us: eda,
        temp_mean_c: temp,
        acc_activity_g: accG,
        activity_state: activity,
        reasons,
        feedback: fb,
      };
    });

    // If Spark series hasn't arrived yet for existing Edge windows, synthesize smooth 10s bridge points
    const effectiveSpark: Spark10sPoint[] =
      sparkSeries.length > 0
        ? sparkSeries
        : edgeWindows.flatMap((ew, wIdx) =>
            [0, 1, 2].map((sub) => {
              const ms = ew.startMs + sub * 10_000;
              const iso = new Date(ms).toISOString();
              return {
                window_start_utc: iso,
                window_end_utc: new Date(ms + 10_000).toISOString(),
                clockLabel: fmtClockShort(iso),
                timestampMs: ms,
                hr_bpm: ew.hr_bpm,
                eda_us: ew.eda_mean_us,
                temp_c: ew.temp_mean_c,
                acc_g: ew.acc_activity_g,
                sample_count_total: 1056,
                spark_batch_id: wIdx * 3 + sub + 1,
              };
            })
          );

    if (edgeWindows.length === 0) {
      const latestSparkPt = effectiveSpark.at(-1);
      const liveHr = latestSparkPt?.hr_bpm ?? null;
      const emptyPersonal: PersonalDashboardData = {
        subjectId: params.subjectId,
        roleLabel: subjMeta.role,
        usingMockFallback: false,
        connectionState: "connected",
        simulatedClockUtc: latestSparkPt ? fmtClockShort(latestSparkPt.window_end_utc) : "--:--:--",
        streamState,
        currentScore: 0,
        currentZone: "RELAXED",
        motionShieldActive: false,
        heroConclusion:
          streamState === "starting" || streamState === "running"
            ? effectiveSpark.length > 0
              ? "⚡ Luồng Spark 10s đã nhận dữ liệu cảm biến trực tiếp — đang gom đủ 30 giây đầu tiên để mô hình Edge AI phân loại Stress..."
              : `Đang nạp dữ liệu thật ${params.subjectId}.pkl và thu thập cửa sổ 30 giây đầu tiên từ Kafka & Spark...`
            : "Chưa có dữ liệu phiên hiện tại. Nhấn ▶ Start hoặc chọn 1 kịch bản bên trên để bắt đầu.",
        confidencePercent: 0,
        activeModelVersion,
        vitals: {
          hrBpm: liveHr,
          baselineHrBpm: subjMeta.baselineHr,
          hrDeltaBpm: liveHr !== null ? +(liveHr - subjMeta.baselineHr).toFixed(1) : null,
          hrvRmssdMs: null,
          baselineHrvMs: 60,
          edaUs: latestSparkPt?.eda_us ?? null,
          baselineEdaUs: subjMeta.baselineEda,
          tempC: latestSparkPt?.temp_c ?? null,
          baselineTempC: 32.9,
          activityState:
            (latestSparkPt?.acc_g ?? 0) >= 0.055
              ? "HIGH_ACTIVITY"
              : (latestSparkPt?.acc_g ?? 0) >= 0.02
                ? "LIGHT_ACTIVITY"
                : "RESTING",
          accG: latestSparkPt?.acc_g ?? null,
        },
        sparkSeries: effectiveSpark,
        edgeWindows: [],
        events: [],
        topReasons: [],
        sessionSummary: {
          stressRatioPercent: 0,
          alertCount: 0,
          peakClock: null,
          peakScore: 0,
          stressDurationMinutes: 0,
        },
      };

      return {
        personal: emptyPersonal,
        team: buildTeamOverviewData(null, teamSummary),
        system: buildSystemTelemetry({
          isStreaming: streamState === "running" || streamState === "starting",
          speed: subjSession?.speed ?? params.speed,
          activeModelVersion,
          scenarioId: params.scenarioId,
          modelsOverride: mappedModels,
          liveTelemetry: telemetry,
          logsOverride: subjSession
            ? {
                producer: subjSession.producer_logs ?? [],
                edge: subjSession.edge_logs ?? [],
              }
            : null,
          tickSeed: params.tickSeed,
        }),
        apiConnected: true,
        backendMode: timeline.mode,
        errorMessage: null,
      };
    }

    const latest = edgeWindows[edgeWindows.length - 1];
    const latestSparkHr = effectiveSpark.at(-1)?.hr_bpm ?? latest.hr_bpm;
    const stressedWins = edgeWindows.filter((w) => w.zone === "STRESS");
    const peakWin = edgeWindows.reduce(
      (best, cur) => (cur.displayStressIndex > best.displayStressIndex ? cur : best),
      edgeWindows[0]
    );

    let activeStreak = 0;
    for (let i = edgeWindows.length - 1; i >= 0; i--) {
      if (edgeWindows[i].zone === "STRESS") activeStreak++;
      else break;
    }
    const activeStressMinutes = +(activeStreak * 0.5).toFixed(1);

    const personal: PersonalDashboardData = {
      subjectId: params.subjectId,
      roleLabel: subjMeta.role,
      usingMockFallback: false,
      connectionState: "connected",
      simulatedClockUtc: fmtClockShort(latest.window_end),
      streamState,
      currentScore: latest.displayStressIndex,
      currentZone: latest.zone,
      motionShieldActive: latest.motionShieldActive,
      heroConclusion: buildHeroConclusion({
        zone: latest.zone,
        motionShield: latest.motionShieldActive,
        stressDurationMinutes: activeStressMinutes,
        hrDeltaBpm:
          latestSparkHr !== null && latest.baseline_hr_bpm !== null
            ? latestSparkHr - latest.baseline_hr_bpm
            : latest.hr_delta_bpm,
        edaUs: latest.eda_mean_us,
        activityState: latest.activity_state,
      }),
      confidencePercent: latest.confidencePercent,
      activeModelVersion: latest.modelVersion || activeModelVersion,
      vitals: {
        hrBpm: latestSparkHr,
        baselineHrBpm: latest.baseline_hr_bpm,
        hrDeltaBpm:
          latestSparkHr !== null && latest.baseline_hr_bpm !== null
            ? +(latestSparkHr - latest.baseline_hr_bpm).toFixed(1)
            : latest.hr_delta_bpm,
        hrvRmssdMs: latest.hrv_rmssd_ms,
        baselineHrvMs: 62,
        edaUs: effectiveSpark.at(-1)?.eda_us ?? latest.eda_mean_us,
        baselineEdaUs: subjMeta.baselineEda,
        tempC: effectiveSpark.at(-1)?.temp_c ?? latest.temp_mean_c,
        baselineTempC: 32.9,
        activityState: latest.activity_state,
        accG: latest.acc_activity_g,
      },
      sparkSeries: effectiveSpark,
      edgeWindows,
      events,
      topReasons: latest.reasons,
      sessionSummary: {
        stressRatioPercent: Math.round((stressedWins.length / edgeWindows.length) * 100),
        alertCount,
        peakClock: fmtClockShort(peakWin.window_start),
        peakScore: peakWin.displayStressIndex,
        stressDurationMinutes: +(stressedWins.length * 0.5).toFixed(1),
      },
    };

    return {
      personal,
      team: buildTeamOverviewData(personal, teamSummary),
      system: buildSystemTelemetry({
        isStreaming: streamState === "running" || streamState === "starting",
        speed: subjSession?.speed ?? params.speed,
        activeModelVersion,
        scenarioId: params.scenarioId,
        modelsOverride: mappedModels,
        liveTelemetry: telemetry,
        logsOverride: subjSession
          ? {
              producer: subjSession.producer_logs ?? [],
              edge: subjSession.edge_logs ?? [],
            }
          : null,
        tickSeed: params.tickSeed,
      }),
      apiConnected: true,
      backendMode: timeline.mode,
      errorMessage: null,
    };
  } catch (err) {
    // Graceful automatic fallback to client-side simulation so demo never breaks!
    const fallbackPersonal = generateMockPersonalState({
      subjectId: params.subjectId,
      scenarioId: params.scenarioId,
      activeModelVersion: params.mockActiveModel,
      visibleWindowsCount: params.mockVisibleWindows,
      streamState: params.mockStreamState,
      connectionState: "reconnecting",
      feedbackMap: params.localFeedbackMap,
    });
    return {
      personal: fallbackPersonal,
      team: buildTeamOverviewData(fallbackPersonal),
      system: buildSystemTelemetry({
        isStreaming: params.mockStreamState === "running",
        speed: params.speed,
        activeModelVersion: params.mockActiveModel,
        scenarioId: params.scenarioId,
        tickSeed: params.tickSeed,
      }),
      apiConnected: false,
      backendMode: "client_mock",
      errorMessage:
        err instanceof Error ? err.message : "Mất kết nối tới Device Manager API — đã chuyển sang mô phỏng.",
    };
  }
}

export async function startScenarioOnApi(params: {
  subjectId: string;
  scenarioId: ScenarioId;
  speed: number;
  forceMockMode: boolean;
}): Promise<{ usedApi: boolean; error?: string }> {
  if (params.forceMockMode) return { usedApi: false };
  const spec = DEMO_SCENARIOS.find((s) => s.id === params.scenarioId) ?? DEMO_SCENARIOS[0];
  try {
    await fetchJsonWithTimeout(`${DEVICE_API}/devices/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subject_id: params.subjectId,
        scenario_id: spec.id,
        start_offset_seconds: spec.start_offset_seconds,
        duration_seconds: spec.duration_seconds,
        speed: params.speed,
        replace_running: true,
      }),
    });
    return { usedApi: true };
  } catch (err) {
    return {
      usedApi: false,
      error: err instanceof Error ? err.message : "Không khởi động được kịch bản trên API",
    };
  }
}

export async function stopStreamOnApi(subjectId: string, forceMockMode: boolean): Promise<void> {
  if (forceMockMode) return;
  try {
    await fetchJsonWithTimeout(`${DEVICE_API}/devices/${encodeURIComponent(subjectId)}/stop`, {
      method: "POST",
    });
  } catch {
    // ignore if already stopped or offline
  }
}

export async function submitUserFeedback(params: {
  subjectId: string;
  windowStart: string;
  verdict: "ACCURATE" | "FALSE_ALARM";
  note: string;
  forceMockMode: boolean;
}): Promise<boolean> {
  if (params.forceMockMode) return true;
  try {
    await fetchJsonWithTimeout(`${DEVICE_API}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subject_id: params.subjectId,
        window_start: params.windowStart,
        verdict: params.verdict,
        note: params.note,
      }),
    });
    return true;
  } catch {
    return false;
  }
}

export async function activateModelVersion(
  version: string,
  forceMockMode: boolean
): Promise<boolean> {
  if (forceMockMode) return true;
  try {
    await fetchJsonWithTimeout(`${REGISTRY_API}/models/${encodeURIComponent(version)}/activate`, {
      method: "PUT",
    });
    return true;
  } catch {
    return false;
  }
}
