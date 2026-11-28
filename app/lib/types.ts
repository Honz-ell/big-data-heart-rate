export type DashboardTab = "personal" | "team" | "system";

export type ScenarioId =
  | "baseline_calm"
  | "tsst_acute_stress"
  | "stress_to_recovery"
  | "physical_activity_check";

export type ActivityLevel = "RESTING" | "LIGHT_ACTIVITY" | "HIGH_ACTIVITY";

export type ZoneState = "RELAXED" | "ATTENTION" | "STRESS";

export type ServiceHealth = "healthy" | "idle" | "degraded" | "down";

export interface DemoScenario {
  id: ScenarioId;
  stepNumber: number;
  title: string;
  shortDesc: string;
  roleExample: string;
  start_offset_seconds: number;
  duration_seconds: number;
  default_speed: number;
  tone: "calm" | "stress" | "recovery" | "motion";
}

export interface Spark10sPoint {
  window_start_utc: string;
  window_end_utc: string;
  clockLabel: string;
  timestampMs: number;
  hr_bpm: number | null;
  eda_us: number | null;
  temp_c: number | null;
  acc_g: number | null;
  sample_count_total: number;
  spark_batch_id: number;
}

export interface ExplainableReason {
  id: string;
  title: string;
  plainSummary: string;
  impactPercent: number;
  direction: "up" | "down" | "neutral";
  sensor: "EDA" | "HRV" | "HR" | "TEMP" | "ACC";
}

export interface Edge30sWindow {
  window_start: string;
  window_end: string;
  startMs: number;
  endMs: number;
  clockRange: string;
  prediction: "STRESS" | "NON_STRESS";
  rawStressScore: number; // 0..1 from Random Forest
  displayStressIndex: number; // 0..100 display index (accounts for motion shield)
  zone: ZoneState;
  motionShieldActive: boolean;
  confidencePercent: number;
  modelVersion: string;
  hr_bpm: number | null;
  baseline_hr_bpm: number | null;
  hr_delta_bpm: number | null;
  hrv_rmssd_ms: number | null;
  eda_mean_us: number | null;
  temp_mean_c: number | null;
  acc_activity_g: number | null;
  activity_state: ActivityLevel;
  reasons: ExplainableReason[];
  feedback?: {
    verdict: "ACCURATE" | "FALSE_ALARM";
    note: string;
  } | null;
}

export interface TimelineEventMarker {
  id: string;
  timestampMs: number;
  clockLabel: string;
  type: "STRESS_ONSET" | "ALERT_SENT" | "USER_FEEDBACK" | "MOTION_SHIELD";
  label: string;
}

export interface PersonalDashboardData {
  subjectId: string;
  roleLabel: string;
  usingMockFallback: boolean;
  connectionState: "connected" | "reconnecting" | "mock_forced";
  simulatedClockUtc: string;
  streamState: "running" | "paused" | "stopped" | "starting";
  currentScore: number; // 0..100
  currentZone: ZoneState;
  motionShieldActive: boolean;
  heroConclusion: string;
  confidencePercent: number;
  activeModelVersion: string;
  vitals: {
    hrBpm: number | null;
    baselineHrBpm: number | null;
    hrDeltaBpm: number | null;
    hrvRmssdMs: number | null;
    baselineHrvMs: number | null;
    edaUs: number | null;
    baselineEdaUs: number | null;
    tempC: number | null;
    baselineTempC: number | null;
    activityState: ActivityLevel;
    accG: number | null;
  };
  sparkSeries: Spark10sPoint[];
  edgeWindows: Edge30sWindow[];
  events: TimelineEventMarker[];
  topReasons: ExplainableReason[];
  sessionSummary: {
    stressRatioPercent: number;
    alertCount: number;
    peakClock: string | null;
    peakScore: number;
    stressDurationMinutes: number;
  };
}

export interface TeamMemberSummary {
  subjectId: string;
  anonymousCode: string;
  departmentRole: string;
  zone: ZoneState;
  motionActive: boolean;
  stressIndex: number;
  hrBpm: number;
  edaUs: number;
  sparkline: number[];
  updatedLabel: string;
  sourceType?: "live_kafka" | "postgres_db" | "simulated";
  windowsCount?: number;
}

export interface HeatmapCell {
  hour: string;
  score: number | null;
  zone: ZoneState | "UNMEASURED";
  clockUtc?: string;
}

export interface HeatmapRow {
  anonymousCode: string;
  subjectId: string;
  role: string;
  hourlyScores: HeatmapCell[];
}

export interface CohortJobState {
  status: "idle" | "running" | "completed" | "failed";
  scenarioId: string | null;
  completedCount: number;
  totalCount: number;
  currentSubject: string | null;
  skippedSubjects?: string[];
  error: string | null;
}

export interface TeamOverviewData {
  stressedRatioPercent: number;
  alertsToday: number;
  avgRecoveryMinutes: number | null;
  realMeasuredCount?: number;
  realStressedCount?: number;
  realStressWindowsTotal?: number;
  realSustainedAlerts?: number;
  realAvgRecoveryMinutes?: number | null;
  realHeatmap?: HeatmapRow[];
  realPeakHours?: {
    hourRange: string;
    avgScore: number;
    affectedPercent: number;
    contextNote: string;
  }[];
  cohortJob?: CohortJobState;
  members: TeamMemberSummary[];
  heatmap: HeatmapRow[];
  topPeakHours: {
    hourRange: string;
    avgScore: number;
    affectedPercent: number;
    contextNote: string;
  }[];
}

export interface SystemMetricPoint {
  timeLabel: string;
  kafkaRecordsPerSec: number;
  sparkProcessedPerSec: number;
  sparkBatchMs: number;
  cpuPercent: number;
  ramMb: number;
}

export interface ModelVersionInfo {
  version: string;
  modelFile: string;
  sha256Short: string;
  sha256Full: string;
  stressRecall: number | null;
  stressF1: number | null;
  heldoutS4F1: number | null;
  releasedAt: string;
  isActive: boolean;
  notes: string;
}

export interface LosoSubjectScore {
  subjectId: string;
  stressRecallPercent: number;
  stressF1Percent: number;
  isHeldOut: boolean;
}

export interface SystemTelemetryData {
  metricsAvailable?: boolean;
  services: {
    kafka: ServiceHealth;
    spark: ServiceHealth;
    edge: ServiceHealth;
    postgres: ServiceHealth;
  };
  liveNodes: {
    sensorRatePerSec: number;
    kafkaRecordsPerSec: number;
    sparkBatchMs: number;
    sparkWindowsTotal: number;
    postgresRowsTotal: number;
    edgeWindowSec: number;
    edgePredictionsTotal: number;
  };
  history: SystemMetricPoint[];
  containers: {
    name: string;
    cpuPercent: number;
    ramMb: number;
    status: "running" | "idle";
  }[];
  models: ModelVersionInfo[];
  comparison: {
    scenarioTitle: string;
    v100: { tn: number; fp: number; fn: number; tp: number; recall: number; f1: number };
    v110: { tn: number; fp: number; fn: number; tp: number; recall: number; f1: number };
  };
  losoBenchmarks: LosoSubjectScore[];
  logs: {
    producer: string[];
    edge: string[];
  };
}
