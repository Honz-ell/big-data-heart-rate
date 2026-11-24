import {
  ActivityLevel,
  DemoScenario,
  Edge30sWindow,
  ExplainableReason,
  HeatmapRow,
  LosoSubjectScore,
  ModelVersionInfo,
  PersonalDashboardData,
  ScenarioId,
  Spark10sPoint,
  SystemMetricPoint,
  SystemTelemetryData,
  TeamMemberSummary,
  TeamOverviewData,
  TimelineEventMarker,
  ZoneState,
} from "./types";

export const DEMO_SCENARIOS: DemoScenario[] = [
  {
    id: "baseline_calm",
    stepNumber: 1,
    title: "Làm việc thư giãn",
    shortDesc: "Trạng thái nền (baseline), nhịp tim & mồ hôi da ổn định.",
    roleExample: "Nhân viên văn phòng đọc tài liệu",
    start_offset_seconds: 300,
    duration_seconds: 180,
    default_speed: 30,
    tone: "calm",
  },
  {
    id: "tsst_acute_stress",
    stepNumber: 2,
    title: "Áp lực thuyết trình (TSST)",
    shortDesc: "Nhịp tim & độ dẫn điện da (EDA) tăng vọt, cảnh báo sớm xuất hiện.",
    roleExample: "Sinh viên bảo vệ đồ án / Điều dưỡng ca cấp cứu",
    start_offset_seconds: 3690,
    duration_seconds: 180,
    default_speed: 30,
    tone: "stress",
  },
  {
    id: "stress_to_recovery",
    stepNumber: 3,
    title: "Căng thẳng → Phục hồi",
    shortDesc: "Sau bài thở 4-4-6, nhịp tim và mồ hôi da hạ dần, đèn chuyển xanh.",
    roleExample: "Nghỉ giải lao & hít thở điều hòa sau ca căng thẳng",
    start_offset_seconds: 4140,
    duration_seconds: 240,
    default_speed: 40,
    tone: "recovery",
  },
  {
    id: "physical_activity_check",
    stepNumber: 4,
    title: "Đi bộ nhanh (chống báo giả)",
    shortDesc: "Nhịp tim tăng cao do vận động nhưng hệ thống KHÔNG báo nhầm stress.",
    roleExample: "Tài xế / Nhân viên đi bộ nhanh lên cầu thang",
    start_offset_seconds: 2100,
    duration_seconds: 180,
    default_speed: 30,
    tone: "motion",
  },
];

export const WESAD_SUBJECTS: {
  id: string;
  anonCode: string;
  role: string;
  baselineHr: number;
  baselineEda: number;
}[] = [
  { id: "S2", anonCode: "NV-02", role: "Nhân viên văn phòng", baselineHr: 68, baselineEda: 0.55 },
  { id: "S3", anonCode: "NV-03", role: "Điều dưỡng ca trực", baselineHr: 72, baselineEda: 0.61 },
  { id: "S4", anonCode: "NV-04", role: "Sinh viên CNTT (Kiểm thử độc lập)", baselineHr: 64, baselineEda: 0.42 },
  { id: "S5", anonCode: "NV-05", role: "Tài xế vận tải", baselineHr: 66, baselineEda: 0.48 },
  { id: "S6", anonCode: "NV-06", role: "Kỹ sư vận hành trực ca", baselineHr: 70, baselineEda: 0.52 },
  { id: "S7", anonCode: "NV-07", role: "Chuyên viên chăm sóc KH", baselineHr: 74, baselineEda: 0.64 },
  { id: "S8", anonCode: "NV-08", role: "Sinh viên năm cuối", baselineHr: 69, baselineEda: 0.51 },
  { id: "S9", anonCode: "NV-09", role: "Điều dưỡng hồi sức", baselineHr: 71, baselineEda: 0.58 },
  { id: "S10", anonCode: "NV-10", role: "Lập trình viên Backend", baselineHr: 65, baselineEda: 0.44 },
  { id: "S11", anonCode: "NV-11", role: "Tài xế tuyến dài", baselineHr: 67, baselineEda: 0.49 },
  { id: "S13", anonCode: "NV-13", role: "Nhân viên điều phối", baselineHr: 73, baselineEda: 0.62 },
  { id: "S14", anonCode: "NV-14", role: "Chuyên viên phân tích", baselineHr: 68, baselineEda: 0.46 },
  { id: "S15", anonCode: "NV-15", role: "Bác sĩ nội trú", baselineHr: 70, baselineEda: 0.54 },
  { id: "S16", anonCode: "NV-16", role: "Giảng viên / Nghiên cứu", baselineHr: 64, baselineEda: 0.41 },
  { id: "S17", anonCode: "NV-17", role: "Kiểm soát viên ca đêm", baselineHr: 72, baselineEda: 0.59 },
];

export const LOSO_BENCHMARKS: LosoSubjectScore[] = [
  { subjectId: "S2", stressRecallPercent: 64.2, stressF1Percent: 68.5, isHeldOut: false },
  { subjectId: "S3", stressRecallPercent: 52.8, stressF1Percent: 55.4, isHeldOut: false },
  { subjectId: "S4", stressRecallPercent: 60.0, stressF1Percent: 75.0, isHeldOut: true },
  { subjectId: "S5", stressRecallPercent: 71.4, stressF1Percent: 72.1, isHeldOut: false },
  { subjectId: "S6", stressRecallPercent: 48.5, stressF1Percent: 51.0, isHeldOut: false },
  { subjectId: "S7", stressRecallPercent: 66.7, stressF1Percent: 65.8, isHeldOut: false },
  { subjectId: "S8", stressRecallPercent: 58.3, stressF1Percent: 60.2, isHeldOut: false },
  { subjectId: "S9", stressRecallPercent: 63.0, stressF1Percent: 62.4, isHeldOut: false },
  { subjectId: "S10", stressRecallPercent: 74.1, stressF1Percent: 73.6, isHeldOut: false },
  { subjectId: "S11", stressRecallPercent: 55.6, stressF1Percent: 57.9, isHeldOut: false },
  { subjectId: "S13", stressRecallPercent: 44.2, stressF1Percent: 47.5, isHeldOut: false },
  { subjectId: "S14", stressRecallPercent: 68.9, stressF1Percent: 67.3, isHeldOut: false },
  { subjectId: "S15", stressRecallPercent: 51.5, stressF1Percent: 53.8, isHeldOut: false },
  { subjectId: "S16", stressRecallPercent: 62.1, stressF1Percent: 63.0, isHeldOut: false },
  { subjectId: "S17", stressRecallPercent: 53.4, stressF1Percent: 56.2, isHeldOut: false },
];

export const DEFAULT_MODELS: ModelVersionInfo[] = [
  {
    version: "v1.0.0",
    modelFile: "v1.0.0.joblib",
    sha256Short: "3278621bd7eb",
    sha256Full: "3278621bd7eba8c6a3479d4b2d8078b1b1c9d0e4f5a6b7c8d9e0f1a2b3c4d5e6",
    stressRecall: 60.0,
    stressF1: 75.0,
    heldoutS4F1: 75.0,
    releasedAt: "2026-11-18 09:00 UTC",
    isActive: true,
    notes: "Random Forest 300 cây (cân bằng Precision/Recall trên tập kiểm thử độc lập S4).",
  },
  {
    version: "v1.1.0",
    modelFile: "v1.1.0.joblib",
    sha256Short: "460e0a5108ee",
    sha256Full: "460e0a5108ee6680ad4899c1f2e3d4b5a69788695a4b3c2d1e0f9a8b7c6d5e4f",
    stressRecall: 68.5,
    stressF1: 56.9,
    heldoutS4F1: 69.2,
    releasedAt: "2026-11-21 14:30 UTC",
    isActive: false,
    notes: "Tối ưu độ nhạy (Recall cao hơn +8.5%) để bắt sớm dấu hiệu căng thẳng nhẹ.",
  },
];

export function scoreToZone(score: number): ZoneState {
  if (score >= 60) return "STRESS";
  if (score >= 40) return "ATTENTION";
  return "RELAXED";
}

export function fmtClockShort(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(11, 19);
    return d.toISOString().slice(11, 19);
  } catch {
    return iso.slice(0, 8);
  }
}

function deterministicNoise(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x) - 0.5;
}

export function buildExplainableReasons(params: {
  edaUs: number | null;
  baselineEdaUs: number | null;
  hrBpm: number | null;
  baselineHrBpm: number | null;
  hrvMs: number | null;
  tempC: number | null;
  activityState: ActivityLevel;
  accG: number | null;
  motionShield: boolean;
  zone: ZoneState;
}): ExplainableReason[] {
  const eda = params.edaUs ?? 0.5;
  const baseEda = Math.max(0.15, params.baselineEdaUs ?? 0.45);
  const edaPct = Math.round(((eda - baseEda) / baseEda) * 100);

  const hr = params.hrBpm ?? 70;
  const baseHr = params.baselineHrBpm ?? 66;
  const hrDiff = Math.round(hr - baseHr);

  const hrv = params.hrvMs;
  const temp = params.tempC ?? 32.8;

  const list: ExplainableReason[] = [];

  if (params.motionShield || params.activityState === "HIGH_ACTIVITY") {
    list.push({
      id: "acc-motion",
      title: `Gia tốc cổ tay cao (${(params.accG ?? 0.16).toFixed(2)} g) — Đang vận động mạnh`,
      plainSummary: "Nhịp tim tăng phù hợp với vận động thể chất, không phải căng thẳng tâm lý.",
      impactPercent: 86,
      direction: "up",
      sensor: "ACC",
    });
    list.push({
      id: "eda-calm-motion",
      title: `Độ dẫn điện mồ hôi da ổn định (${eda.toFixed(2)} µS)`,
      plainSummary: "Chưa xuất hiện đợt tiết mồ hôi lạnh đặc trưng của stress cấp tính.",
      impactPercent: 54,
      direction: "neutral",
      sensor: "EDA",
    });
    list.push({
      id: "hr-exercise",
      title: `Nhịp tim đáp ứng vận động (${Math.round(hr)} BPM, ${hrDiff >= 0 ? `+${hrDiff}` : hrDiff} BPM)`,
      plainSummary: "Tăng sinh lý tự nhiên khi đi bộ nhanh hoặc leo cầu thang.",
      impactPercent: 48,
      direction: "up",
      sensor: "HR",
    });
    return list;
  }

  if (edaPct >= 25) {
    list.push({
      id: "eda-rise",
      title: `Độ dẫn điện da (EDA) tăng +${Math.min(edaPct, 480)}% (${eda.toFixed(2)} µS)`,
      plainSummary: "Tuyến mồ hôi cổ tay kích hoạt mạnh do hệ thần kinh giao cảm căng thẳng.",
      impactPercent: Math.min(96, 48 + Math.round(edaPct * 0.25)),
      direction: "up",
      sensor: "EDA",
    });
  } else {
    list.push({
      id: "eda-steady",
      title: `Độ dẫn điện mồ hôi da thấp (${eda.toFixed(2)} µS)`,
      plainSummary: "Mức mồ hôi giao cảm nằm trong ngưỡng thư giãn bình thường.",
      impactPercent: 24,
      direction: "neutral",
      sensor: "EDA",
    });
  }

  if (hrv !== null && hrv < 36) {
    list.push({
      id: "hrv-drop",
      title: `Biến thiên nhịp tim (HRV) giảm thấp (${Math.round(hrv)} ms)`,
      plainSummary: "Khoảng cách giữa các nhịp tim kém linh hoạt khi cơ thể chịu áp lực.",
      impactPercent: Math.min(88, Math.round((50 - hrv) * 2.1)),
      direction: "down",
      sensor: "HRV",
    });
  } else if (hrv !== null) {
    list.push({
      id: "hrv-good",
      title: `Biến thiên nhịp tim (HRV) tốt (${Math.round(hrv)} ms)`,
      plainSummary: "Hệ thần kinh đối giao cảm hoạt động tốt, cơ thể đang thích nghi ổn định.",
      impactPercent: 30,
      direction: "up",
      sensor: "HRV",
    });
  } else if (Math.abs(hrDiff) >= 8) {
    list.push({
      id: "hr-shift",
      title: `Nhịp tim ${hrDiff > 0 ? `cao hơn mức nghỉ +${hrDiff}` : `thấp hơn ${hrDiff}`} BPM (${Math.round(hr)} BPM)`,
      plainSummary:
        hrDiff > 0
          ? "Tim đập nhanh hơn mức nền cá nhân trong khi cơ thể ít vận động."
          : "Nhịp tim đang quay về trạng thái nghỉ ngơi.",
      impactPercent: Math.min(82, 35 + Math.abs(hrDiff) * 2),
      direction: hrDiff > 0 ? "up" : "down",
      sensor: "HR",
    });
  }

  list.push({
    id: "temp-context",
    title:
      params.zone === "STRESS"
        ? `Nhiệt độ cổ tay giảm nhẹ (${temp.toFixed(1)} °C)`
        : `Nhiệt độ cổ tay ổn định (${temp.toFixed(1)} °C)`,
    plainSummary:
      params.zone === "STRESS"
        ? "Co mạch ngoại vi nhẹ thường đi kèm phản ứng căng thẳng cấp."
        : "Tuần hoàn ngoại vi cổ tay duy trì trạng thái ấm tự nhiên.",
    impactPercent: params.zone === "STRESS" ? 44 : 18,
    direction: params.zone === "STRESS" ? "down" : "neutral",
    sensor: "TEMP",
  });

  return list.slice(0, 3);
}

export function buildHeroConclusion(params: {
  zone: ZoneState;
  motionShield: boolean;
  stressDurationMinutes: number;
  hrDeltaBpm: number | null;
  edaUs: number | null;
  activityState: ActivityLevel;
}): string {
  const hrDelta = params.hrDeltaBpm !== null ? Math.round(params.hrDeltaBpm) : 0;

  if (params.motionShield) {
    return `Đang đi bộ / vận động mạnh: nhịp tim tăng ${hrDelta > 0 ? `+${hrDelta}` : "+28"} BPM do thể chất, hệ thống đã tự động chặn cảnh báo giả.`;
  }

  if (params.zone === "STRESS") {
    const durText =
      params.stressDurationMinutes >= 1
        ? `kéo dài ${params.stressDurationMinutes.toFixed(1).replace(".0", "")} phút`
        : "vừa xuất hiện trong 30 giây qua";
    const hrClause =
      hrDelta >= 6 ? `Nhịp tim cao hơn mức nghỉ ${hrDelta} BPM, ` : "Tín hiệu sinh lý thay đổi rõ, ";
    return `Bạn đang căng thẳng rõ rệt (${durText}). ${hrClause}độ dẫn điện mồ hôi da tăng cao (${(params.edaUs ?? 2.4).toFixed(2)} µS).`;
  }

  if (params.zone === "ATTENTION") {
    return `Cơ thể đang ở mức chú ý / chuyển pha. Nhịp tim chênh ${hrDelta >= 0 ? `+${hrDelta}` : hrDelta} BPM so với mức nghỉ, nên thư giãn nhẹ 1–2 phút.`;
  }

  return "Trạng thái sinh lý ổn định và thư giãn. Nhịp tim, độ dẫn điện da và nhiệt độ cổ tay đều nằm trong vùng nghỉ ngơi an toàn.";
}

export function generateMockPersonalState(options: {
  subjectId: string;
  scenarioId: ScenarioId;
  activeModelVersion: string;
  visibleWindowsCount: number;
  streamState: "running" | "paused" | "stopped" | "starting";
  connectionState: "connected" | "reconnecting" | "mock_forced";
  feedbackMap: Record<string, { verdict: "ACCURATE" | "FALSE_ALARM"; note: string }>;
}): PersonalDashboardData {
  const subj = WESAD_SUBJECTS.find((s) => s.id === options.subjectId) ?? WESAD_SUBJECTS[0];
  const totalWindows = options.scenarioId === "stress_to_recovery" ? 12 : 10; // 5 to 6 minutes
  const count = Math.max(1, Math.min(totalWindows, options.visibleWindowsCount));
  const baseEpochMs = Date.UTC(2017, 5, 13, 9, 30, 0);
  const modelBoost = options.activeModelVersion === "v1.1.0" ? 5 : 0;

  const sparkSeries: Spark10sPoint[] = [];
  const edgeWindows: Edge30sWindow[] = [];
  const events: TimelineEventMarker[] = [];

  let stressStreak = 0;
  let alertCount = 0;

  for (let w = 0; w < count; w++) {
    const frac = w / Math.max(1, totalWindows - 1);
    const wStartMs = baseEpochMs + w * 30_000;
    const wEndMs = wStartMs + 30_000;
    const wStartIso = new Date(wStartMs).toISOString();
    const wEndIso = new Date(wEndMs).toISOString();

    let hr = subj.baselineHr;
    let hrv = 58;
    let eda = subj.baselineEda;
    let temp = 32.9;
    let accG = 0.018;
    let activity: ActivityLevel = "RESTING";
    let rawRf = 0.18;

    if (options.scenarioId === "baseline_calm") {
      hr = subj.baselineHr + Math.round(deterministicNoise(w + 1) * 4);
      hrv = 64 + Math.round(deterministicNoise(w + 5) * 14);
      eda = +(subj.baselineEda + deterministicNoise(w + 9) * 0.06).toFixed(2);
      temp = +(32.92 + deterministicNoise(w + 13) * 0.08).toFixed(2);
      accG = 0.016;
      activity = "RESTING";
      rawRf = Math.max(0.08, Math.min(0.32, 0.18 + deterministicNoise(w + 3) * 0.08 + modelBoost / 100));
    } else if (options.scenarioId === "tsst_acute_stress") {
      if (w < 2) {
        hr = subj.baselineHr + 5 + w * 4;
        hrv = 46 - w * 6;
        eda = +(subj.baselineEda + 0.35 + w * 0.45).toFixed(2);
        temp = 32.82;
        accG = 0.035;
        activity = "LIGHT_ACTIVITY";
        rawRf = 0.38 + w * 0.14 + modelBoost / 100;
      } else {
        const intensity = Math.min(1, (w - 1) / 5);
        hr = subj.baselineHr + 18 + Math.round(intensity * 10 + deterministicNoise(w) * 3);
        hrv = Math.max(21, 31 - Math.round(intensity * 9));
        eda = +(2.15 + intensity * 1.15 + deterministicNoise(w + 2) * 0.15).toFixed(2);
        temp = +(32.68 - intensity * 0.22).toFixed(2);
        accG = 0.042;
        activity = "LIGHT_ACTIVITY";
        rawRf = Math.min(0.97, 0.74 + intensity * 0.2 + modelBoost / 100);
      }
    } else if (options.scenarioId === "stress_to_recovery") {
      if (w < 5) {
        const ramp = w / 4;
        hr = subj.baselineHr + 17 + Math.round(ramp * 7);
        hrv = 26 - Math.round(ramp * 4);
        eda = +(2.25 + ramp * 0.65).toFixed(2);
        temp = 32.58;
        accG = 0.032;
        activity = "LIGHT_ACTIVITY";
        rawRf = Math.min(0.94, 0.76 + ramp * 0.15 + modelBoost / 100);
      } else {
        const rec = (w - 4) / Math.max(1, totalWindows - 5);
        hr = Math.round(subj.baselineHr + 22 * (1 - rec) + 1);
        hrv = Math.round(25 + 42 * rec);
        eda = +(2.45 - 1.92 * rec).toFixed(2);
        temp = +(32.6 + 0.34 * rec).toFixed(2);
        accG = 0.015;
        activity = "RESTING";
        rawRf = Math.max(0.14, 0.68 * (1 - rec * 0.92) + modelBoost / 100);
      }
    } else {
      // physical_activity_check: Brisk walking — high BPM + high ACC, low sympathetic sweat
      const walkWave = Math.sin(frac * Math.PI);
      hr = subj.baselineHr + 34 + Math.round(walkWave * 14);
      hrv = 34;
      eda = +(subj.baselineEda + 0.18 + frac * 0.12).toFixed(2);
      temp = +(32.55 - frac * 0.12).toFixed(2);
      accG = +(0.19 + walkWave * 0.06).toFixed(3);
      activity = w === 0 ? "LIGHT_ACTIVITY" : "HIGH_ACTIVITY";
      rawRf = 0.44 + walkWave * 0.12;
    }

    for (let s = 0; s < 3; s++) {
      const sStartMs = wStartMs + s * 10_000;
      const sEndMs = sStartMs + 10_000;
      const stepJitter = deterministicNoise(w * 10 + s);
      sparkSeries.push({
        window_start_utc: new Date(sStartMs).toISOString(),
        window_end_utc: new Date(sEndMs).toISOString(),
        clockLabel: fmtClockShort(new Date(sStartMs).toISOString()),
        timestampMs: sStartMs,
        hr_bpm: +(hr + stepJitter * 2.4).toFixed(1),
        eda_us: +Math.max(0.1, eda + stepJitter * 0.08).toFixed(2),
        temp_c: +(temp + stepJitter * 0.03).toFixed(2),
        acc_g: +Math.max(0.01, accG + stepJitter * 0.01).toFixed(3),
        sample_count_total: 1058 + Math.round(stepJitter * 6),
        spark_batch_id: w * 3 + s + 1,
      });
    }

    const motionShield = activity === "HIGH_ACTIVITY";
    const displayScore = motionShield
      ? Math.min(34, Math.round(rawRf * 52))
      : Math.round(Math.max(0, Math.min(1, rawRf)) * 100);
    const zone: ZoneState = motionShield ? "RELAXED" : scoreToZone(displayScore);
    const prediction: "STRESS" | "NON_STRESS" =
      !motionShield && rawRf >= 0.5 ? "STRESS" : "NON_STRESS";

    const fb = options.feedbackMap[wStartIso] ?? null;

    if (zone === "STRESS") {
      stressStreak += 1;
      if (stressStreak === 1) {
        events.push({
          id: `onset-${w}`,
          timestampMs: wStartMs,
          clockLabel: fmtClockShort(wStartIso),
          type: "STRESS_ONSET",
          label: "Bắt đầu căng thẳng",
        });
      }
      if (stressStreak === 2) {
        alertCount += 1;
        events.push({
          id: `alert-${w}`,
          timestampMs: wStartMs + 10_000,
          clockLabel: fmtClockShort(new Date(wStartMs + 10_000).toISOString()),
          type: "ALERT_SENT",
          label: "Đã gửi cảnh báo sớm",
        });
      }
    } else {
      stressStreak = 0;
    }

    if (motionShield && w === 1) {
      events.push({
        id: `shield-${w}`,
        timestampMs: wStartMs,
        clockLabel: fmtClockShort(wStartIso),
        type: "MOTION_SHIELD",
        label: "Chặn báo giả (đang đi bộ)",
      });
    }

    if (fb) {
      events.push({
        id: `fb-${w}`,
        timestampMs: wStartMs + 20_000,
        clockLabel: fmtClockShort(wStartIso),
        type: "USER_FEEDBACK",
        label: fb.verdict === "ACCURATE" ? "Xác nhận: Đúng" : "Phản hồi: Báo nhầm",
      });
    }

    const reasons = buildExplainableReasons({
      edaUs: eda,
      baselineEdaUs: subj.baselineEda,
      hrBpm: hr,
      baselineHrBpm: subj.baselineHr,
      hrvMs: activity === "HIGH_ACTIVITY" ? null : hrv,
      tempC: temp,
      activityState: activity,
      accG,
      motionShield,
      zone,
    });

    edgeWindows.push({
      window_start: wStartIso,
      window_end: wEndIso,
      startMs: wStartMs,
      endMs: wEndMs,
      clockRange: `${fmtClockShort(wStartIso)}–${fmtClockShort(wEndIso)}`,
      prediction,
      rawStressScore: +rawRf.toFixed(3),
      displayStressIndex: displayScore,
      zone,
      motionShieldActive: motionShield,
      confidencePercent: Math.round(74 + Math.abs(rawRf - 0.5) * 48),
      modelVersion: options.activeModelVersion,
      hr_bpm: hr,
      baseline_hr_bpm: subj.baselineHr,
      hr_delta_bpm: hr - subj.baselineHr,
      hrv_rmssd_ms: activity === "HIGH_ACTIVITY" ? null : hrv,
      eda_mean_us: eda,
      temp_mean_c: temp,
      acc_activity_g: accG,
      activity_state: activity,
      reasons,
      feedback: fb,
    });
  }

  const latest = edgeWindows[edgeWindows.length - 1];
  const stressedWindows = edgeWindows.filter((w) => w.zone === "STRESS");
  const peakWin = edgeWindows.reduce(
    (best, cur) => (cur.displayStressIndex > best.displayStressIndex ? cur : best),
    edgeWindows[0]
  );

  // Compute current consecutive stress duration in minutes
  let activeStressCount = 0;
  for (let i = edgeWindows.length - 1; i >= 0; i--) {
    if (edgeWindows[i].zone === "STRESS") activeStressCount++;
    else break;
  }
  const stressDurationMinutes = +(activeStressCount * 0.5).toFixed(1);

  return {
    subjectId: subj.id,
    roleLabel: subj.role,
    usingMockFallback: options.connectionState !== "connected",
    connectionState: options.connectionState,
    simulatedClockUtc: fmtClockShort(latest.window_end),
    streamState: options.streamState,
    currentScore: latest.displayStressIndex,
    currentZone: latest.zone,
    motionShieldActive: latest.motionShieldActive,
    heroConclusion: buildHeroConclusion({
      zone: latest.zone,
      motionShield: latest.motionShieldActive,
      stressDurationMinutes,
      hrDeltaBpm: latest.hr_delta_bpm,
      edaUs: latest.eda_mean_us,
      activityState: latest.activity_state,
    }),
    confidencePercent: latest.confidencePercent,
    activeModelVersion: options.activeModelVersion,
    vitals: {
      hrBpm: latest.hr_bpm,
      baselineHrBpm: latest.baseline_hr_bpm,
      hrDeltaBpm: latest.hr_delta_bpm,
      hrvRmssdMs: latest.hrv_rmssd_ms,
      baselineHrvMs: 62,
      edaUs: latest.eda_mean_us,
      baselineEdaUs: subj.baselineEda,
      tempC: latest.temp_mean_c,
      baselineTempC: 32.9,
      activityState: latest.activity_state,
      accG: latest.acc_activity_g,
    },
    sparkSeries,
    edgeWindows,
    events,
    topReasons: latest.reasons,
    sessionSummary: {
      stressRatioPercent: Math.round((stressedWindows.length / edgeWindows.length) * 100),
      alertCount,
      peakClock: peakWin ? fmtClockShort(peakWin.window_start) : null,
      peakScore: peakWin ? peakWin.displayStressIndex : 0,
      stressDurationMinutes: +(stressedWindows.length * 0.5).toFixed(1),
    },
  };
}

export interface RawTeamSubjectSummary {
  subject_id: string;
  is_streaming: boolean;
  latest_window_end: string;
  prediction: string;
  stress_index: number;
  hr_bpm: number | null;
  eda_us: number | null;
  activity_state: string;
  sparkline: number[];
  windows_count: number;
}

export interface RawTeamSummaryPayload {
  mode?: string;
  measured_subjects_count?: number;
  total_stress_windows?: number;
  cohort_job?: {
    status?: "idle" | "running" | "completed" | "failed";
    scenario_id?: string | null;
    completed_count?: number;
    total_count?: number;
    current_subject?: string | null;
    error?: string | null;
  };
  subjects?: Record<string, RawTeamSubjectSummary>;
}

export function buildTeamOverviewData(
  activePersonal?: PersonalDashboardData | null,
  realTeam?: RawTeamSummaryPayload | null
): TeamOverviewData {
  const hours = ["08:00", "09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00", "17:00"];
  const realMap = realTeam?.subjects ?? {};

  const members: TeamMemberSummary[] = WESAD_SUBJECTS.map((subj, idx) => {
    const dbEntry = realMap[subj.id];

    // 1. Currently selected subject in Tab 1 if it has real windows
    if (
      activePersonal &&
      activePersonal.subjectId === subj.id &&
      activePersonal.edgeWindows.length > 0 &&
      !activePersonal.usingMockFallback
    ) {
      const tailScores = activePersonal.edgeWindows.slice(-8).map((w) => w.displayStressIndex);
      const isRunning =
        activePersonal.streamState === "running" || activePersonal.streamState === "starting";
      return {
        subjectId: subj.id,
        anonymousCode: subj.anonCode,
        departmentRole: subj.role,
        zone: activePersonal.currentZone,
        motionActive: activePersonal.motionShieldActive,
        stressIndex: activePersonal.currentScore,
        hrBpm: Math.round(activePersonal.vitals.hrBpm ?? subj.baselineHr),
        edaUs: +(activePersonal.vitals.edaUs ?? subj.baselineEda).toFixed(2),
        sparkline: tailScores.length >= 2 ? tailScores : [activePersonal.currentScore, activePersonal.currentScore],
        updatedLabel: isRunning ? "⚡ Đang phát Kafka" : "● Dữ liệu DB thật",
        sourceType: isRunning ? "live_kafka" : "postgres_db",
        windowsCount: dbEntry?.windows_count ?? activePersonal.edgeWindows.length,
      };
    }

    // 2. Any other subject (S2..S17) that has real predictions stored in PostgreSQL!
    if (dbEntry) {
      const motion =
        dbEntry.activity_state === "HIGH_ACTIVITY" && (dbEntry.eda_us === null || dbEntry.eda_us < 2.1);
      const effScore = motion ? Math.min(35, dbEntry.stress_index) : dbEntry.stress_index;
      const zone: ZoneState = motion ? "RELAXED" : scoreToZone(effScore);
      const spk =
        dbEntry.sparkline && dbEntry.sparkline.length >= 2
          ? dbEntry.sparkline
          : [effScore, effScore];
      return {
        subjectId: subj.id,
        anonymousCode: subj.anonCode,
        departmentRole: subj.role,
        zone,
        motionActive: motion,
        stressIndex: effScore,
        hrBpm: Math.round(dbEntry.hr_bpm ?? subj.baselineHr),
        edaUs: +(dbEntry.eda_us ?? subj.baselineEda).toFixed(2),
        sparkline: spk,
        updatedLabel: dbEntry.is_streaming
          ? "⚡ Đang phát Kafka"
          : `● DB thật (${dbEntry.windows_count} cửa sổ)`,
        sourceType: dbEntry.is_streaming ? "live_kafka" : "postgres_db",
        windowsCount: dbEntry.windows_count,
      };
    }

    // 3. Fallback when in pure Mock mode for selected subject
    if (activePersonal && activePersonal.subjectId === subj.id) {
      const tailScores = activePersonal.edgeWindows.slice(-8).map((w) => w.displayStressIndex);
      return {
        subjectId: subj.id,
        anonymousCode: subj.anonCode,
        departmentRole: subj.role,
        zone: activePersonal.currentZone,
        motionActive: activePersonal.motionShieldActive,
        stressIndex: activePersonal.currentScore,
        hrBpm: Math.round(activePersonal.vitals.hrBpm ?? subj.baselineHr),
        edaUs: +(activePersonal.vitals.edaUs ?? subj.baselineEda).toFixed(2),
        sparkline: tailScores.length >= 3 ? tailScores : [24, 28, activePersonal.currentScore],
        updatedLabel: "Mô phỏng trực tiếp",
        sourceType: "simulated",
      };
    }

    // 4. Deterministic simulated cohort member (for subjects not yet replayed into PostgreSQL)
    const baseProfiles = [78, 31, 66, 28, 49, 24, 72, 33, 21, 52, 29, 44, 26, 35, 63];
    const score = baseProfiles[idx % baseProfiles.length];
    const motion = idx === 4; // NV-06 walking patrol
    const effScore = motion ? 30 : score;
    const zone = scoreToZone(effScore);
    const sparkline = Array.from({ length: 8 }, (_, k) =>
      Math.max(12, Math.min(95, Math.round(effScore + deterministicNoise(idx * 17 + k) * 18)))
    );

    return {
      subjectId: subj.id,
      anonymousCode: subj.anonCode,
      departmentRole: subj.role,
      zone,
      motionActive: motion,
      stressIndex: effScore,
      hrBpm: motion ? subj.baselineHr + 32 : subj.baselineHr + Math.round((effScore - 25) * 0.36),
      edaUs: +(subj.baselineEda + (effScore > 55 ? 1.55 : 0.12)).toFixed(2),
      sparkline,
      updatedLabel: "Mô phỏng ca trực",
      sourceType: "simulated",
    };
  });

  const realMembers = members.filter(
    (m) => m.sourceType === "live_kafka" || m.sourceType === "postgres_db"
  );
  const realStressedCount = realMembers.filter((m) => m.zone === "STRESS").length;
  const stressedCount = members.filter((m) => m.zone === "STRESS").length;

  const heatmap: HeatmapRow[] = WESAD_SUBJECTS.map((subj, rIdx) => {
    const memberObj = members[rIdx];
    const dbEntry = realMap[subj.id];
    const hourlyScores = hours.map((hour, hIdx) => {
      const rushBoost = hIdx === 2 ? 28 : hIdx === 6 ? 25 : hIdx === 3 ? 16 : 0;
      let raw: number;
      if (dbEntry && hIdx === 2) {
        // 10:00 reflects exact real PostgreSQL latest stress score of this subject
        raw = memberObj.stressIndex;
      } else if (dbEntry && dbEntry.sparkline.length > 0 && hIdx === 3) {
        // 11:00 reflects earliest window in the subject's real DB batch
        raw = dbEntry.sparkline[0];
      } else {
        raw = Math.round(
          24 + rushBoost + (rIdx % 3 === 0 ? 18 : 4) + deterministicNoise(rIdx * 31 + hIdx) * 16
        );
      }
      const clamped = Math.max(0, Math.min(100, raw));
      return {
        hour,
        score: clamped,
        zone: scoreToZone(clamped),
      };
    });
    return {
      anonymousCode: subj.anonCode,
      subjectId: subj.id,
      role: subj.role,
      hourlyScores,
    };
  });

  return {
    stressedRatioPercent: Math.round((stressedCount / members.length) * 100),
    alertsToday: realTeam?.total_stress_windows
      ? Math.max(1, Math.floor(realTeam.total_stress_windows / 2))
      : 14 + stressedCount,
    avgRecoveryMinutes: 3.5,
    realMeasuredCount: realMembers.length,
    realStressedCount,
    realStressWindowsTotal: realTeam?.total_stress_windows ?? 0,
    cohortJob: realTeam?.cohort_job
      ? {
          status: realTeam.cohort_job.status ?? "idle",
          scenarioId: realTeam.cohort_job.scenario_id ?? null,
          completedCount: realTeam.cohort_job.completed_count ?? 0,
          totalCount: realTeam.cohort_job.total_count ?? 15,
          currentSubject: realTeam.cohort_job.current_subject ?? null,
          error: realTeam.cohort_job.error ?? null,
        }
      : undefined,
    members,
    heatmap,
    topPeakHours: [
      {
        hourRange: "10:00 – 11:00",
        avgScore: 68,
        affectedPercent: 40,
        contextNote: "Cao điểm họp giao ban / thuyết trình & xử lý sự cố ca sáng.",
      },
      {
        hourRange: "15:00 – 16:00",
        avgScore: 64,
        affectedPercent: 33,
        contextNote: "Mệt mỏi tích lũy giữa buổi chiều — khuyến nghị nhắc nghỉ ngắn 5 phút.",
      },
      {
        hourRange: "11:00 – 11:45",
        avgScore: 54,
        affectedPercent: 27,
        contextNote: "Áp lực chốt tiến độ trước giờ nghỉ trưa.",
      },
    ],
  };
}

export function buildSystemTelemetry(options: {
  isStreaming: boolean;
  speed: number;
  activeModelVersion: string;
  scenarioId: ScenarioId;
  modelsOverride?: ModelVersionInfo[];
  liveTelemetry?: {
    services?: SystemTelemetryData["services"];
    kafka_records_per_sec?: number;
    spark_processed_per_sec?: number;
    spark_batch_ms?: number;
    total_predictions?: number;
    total_spark_windows?: number;
  } | null;
  logsOverride?: { producer: string[]; edge: string[] } | null;
  tickSeed: number;
}): SystemTelemetryData {
  const scenario = DEMO_SCENARIOS.find((s) => s.id === options.scenarioId) ?? DEMO_SCENARIOS[0];
  const baseRate = options.isStreaming ? Math.round(106 * options.speed) : 0;
  const kafkaRate = options.liveTelemetry?.kafka_records_per_sec ?? baseRate;
  const sparkRate =
    options.liveTelemetry?.spark_processed_per_sec ?? Math.round(kafkaRate * 0.99);
  const batchMs =
    options.liveTelemetry?.spark_batch_ms ?? (options.isStreaming ? 178 : 38);

  const history: SystemMetricPoint[] = Array.from({ length: 12 }, (_, idx) => {
    const tSec = (11 - idx) * 3;
    const activeFactor = options.isStreaming ? 1 : idx > 8 ? 0 : 0.3;
    const jitter = deterministicNoise(options.tickSeed + idx * 7);
    const kRate = Math.max(
      0,
      Math.round((kafkaRate || 3180) * activeFactor + jitter * 160 * activeFactor)
    );
    const sRate = Math.max(0, Math.round(kRate * (0.98 + jitter * 0.02)));
    return {
      timeLabel: tSec === 0 ? "Hiện tại" : `-${tSec}s`,
      kafkaRecordsPerSec: kRate,
      sparkProcessedPerSec: sRate,
      sparkBatchMs: Math.round((options.isStreaming ? batchMs : 42) + jitter * 26),
      cpuPercent: Math.round((options.isStreaming ? 36 : 11) + jitter * 7),
      ramMb: Math.round(1180 + jitter * 35),
    };
  });

  const models = (options.modelsOverride ?? DEFAULT_MODELS).map((m) => ({
    ...m,
    isActive: m.version === options.activeModelVersion,
  }));

  const defaultLogs = {
    producer: [
      `[produce_e4] Đang phát ${scenario.title} (S4, speed=${options.speed}x, 6 kênh E4: ACC,BVP,EDA,HR,IBI,TEMP)`,
      `[produce_e4] Đã cấp mốc replay_stream_clock từ PostgreSQL (dịch watermark an toàn)`,
      `[produce_e4] Đã gửi 15,900 mẫu → topic wearable.sensor.v1 (${kafkaRate || 3180} bản ghi/giây)`,
      options.isStreaming
        ? `[produce_e4] Streaming ổn định · độ trễ gửi Kafka < 4ms`
        : `[produce_e4] Đã gửi bản tin __CONTROL__ chốt sổ các cửa sổ Spark 10s.`,
    ],
    edge: [
      `[edge_inference] Đã nạp mô hình Active: version=${options.activeModelVersion} (SHA-256 verified)`,
      `[edge_inference] Tự động kiểm tra Model Registry mỗi 5s (Zero-downtime Hot-Swap)`,
      `[edge_inference] Gom đủ cửa sổ 30s: ACC=960, BVP=1920, EDA=120, TEMP=120, HR=30`,
      `[edge_inference] Đã ghi kết quả dự đoán + giải thích sinh lý vào bảng stress_predictions.`,
    ],
  };

  return {
    services: options.liveTelemetry?.services ?? {
      kafka: options.isStreaming ? "healthy" : "idle",
      spark: "healthy",
      edge: options.isStreaming ? "healthy" : "idle",
      postgres: "healthy",
    },
    liveNodes: {
      sensorRatePerSec: options.isStreaming ? 106 * options.speed : 0,
      kafkaRecordsPerSec: kafkaRate,
      sparkBatchMs: batchMs,
      sparkWindowsTotal: options.liveTelemetry?.total_spark_windows ?? 184,
      postgresRowsTotal:
        (options.liveTelemetry?.total_predictions ?? 62) +
        (options.liveTelemetry?.total_spark_windows ?? 184) * 5,
      edgeWindowSec: 30,
      edgePredictionsTotal: options.liveTelemetry?.total_predictions ?? 62,
    },
    history,
    containers: [
      {
        name: "wesad-spark (Spark 4.3)",
        cpuPercent: options.isStreaming ? 42 : 8,
        ramMb: 892,
        status: "running",
      },
      {
        name: "wesad-kafka (KRaft 4.4)",
        cpuPercent: options.isStreaming ? 18 : 4,
        ramMb: 540,
        status: "running",
      },
      {
        name: "wesad-postgres (PG 17)",
        cpuPercent: options.isStreaming ? 9 : 2,
        ramMb: 196,
        status: "running",
      },
      {
        name: "edge-inference (RF 30s)",
        cpuPercent: options.isStreaming ? 14 : 1,
        ramMb: 148,
        status: options.isStreaming ? "running" : "idle",
      },
    ],
    models,
    comparison: {
      scenarioTitle: scenario.title,
      v100: { tn: 142, fp: 4, fn: 12, tp: 18, recall: 60.0, f1: 75.0 },
      v110: { tn: 131, fp: 15, fn: 8, tp: 22, recall: 73.3, f1: 65.7 },
    },
    losoBenchmarks: LOSO_BENCHMARKS,
    logs:
      options.logsOverride &&
      (options.logsOverride.producer.length > 0 || options.logsOverride.edge.length > 0)
        ? options.logsOverride
        : defaultLogs,
  };
}
