"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { BreathingModal } from "./components/BreathingModal";
import { ControlBar } from "./components/ControlBar";
import { DemoChecklistState, DemoGuideWidget } from "./components/DemoGuideWidget";
import { PersonalTab } from "./components/PersonalTab";
import { SystemModelTab } from "./components/SystemModelTab";
import { TeamTab } from "./components/TeamTab";
import { DEMO_SCENARIOS } from "./lib/mockEngine";
import { DashboardTab, ScenarioId } from "./lib/types";
import {
  activateModelVersion,
  AdapterFetchBundle,
  fetchDashboardBundle,
  startScenarioOnApi,
  stopStreamOnApi,
  submitUserFeedback,
} from "./lib/wesadAdapter";

export default function HomePage() {
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [activeTab, setActiveTab] = useState<DashboardTab>("personal");
  const [subjectId, setSubjectId] = useState<string>("S4");
  const [scenarioId, setScenarioId] = useState<ScenarioId>("baseline_calm");
  const [speed, setSpeed] = useState<number>(30);

  // Playback & fallback state
  const [forceMockMode, setForceMockMode] = useState<boolean>(false);
  const [pausedLocally, setPausedLocally] = useState<boolean>(false);
  const [mockStreamState, setMockStreamState] = useState<
    "running" | "paused" | "stopped" | "starting"
  >("running");
  const [mockVisibleWindows, setMockVisibleWindows] = useState<number>(6);
  const [mockActiveModel, setMockActiveModel] = useState<string>("v1.0.0");
  const [localFeedbackMap, setLocalFeedbackMap] = useState<
    Record<string, { verdict: "ACCURATE" | "FALSE_ALARM"; note: string }>
  >({});

  // Data bundle & UI state
  const [bundle, setBundle] = useState<AdapterFetchBundle | null>(null);
  const [initialLoading, setInitialLoading] = useState<boolean>(true);
  const [breathingOpen, setBreathingOpen] = useState<boolean>(false);
  const [tickSeed, setTickSeed] = useState<number>(1);
  const [retryCountdown, setRetryCountdown] = useState<number>(3);
  const [actionError, setActionError] = useState<string | null>(null);

  // 4-Step Demo Guide auto-tracking
  const [checklist, setChecklist] = useState<DemoChecklistState>({
    ranBaseline: true,
    ranStressAndAlert: false,
    ranMotionShield: false,
    swappedModel: false,
  });

  const inFlightRef = useRef<boolean>(false);
  const reqSeqRef = useRef<number>(0);

  // Sync theme attribute on <html>
  useEffect(() => {
    const saved = window.localStorage.getItem("wesad-theme");
    if (saved === "light" || saved === "dark") {
      setTheme(saved);
      document.documentElement.setAttribute("data-theme", saved);
    } else {
      document.documentElement.setAttribute("data-theme", "dark");
    }
  }, []);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    window.localStorage.setItem("wesad-theme", next);
  };

  const loadBundle = useCallback(
    async (
      seedOverride?: number,
      overrides?: {
        force?: boolean;
        subjectId?: string;
        scenarioId?: ScenarioId;
        speed?: number;
      }
    ) => {
      if (inFlightRef.current && !overrides?.force) return;
      inFlightRef.current = true;
      const mySeq = ++reqSeqRef.current;
      try {
        const res = await fetchDashboardBundle({
          subjectId: overrides?.subjectId ?? subjectId,
          scenarioId: overrides?.scenarioId ?? scenarioId,
          speed: overrides?.speed ?? speed,
          forceMockMode,
          pausedLocally,
          mockVisibleWindows,
          mockStreamState,
          mockActiveModel,
          localFeedbackMap,
          tickSeed: seedOverride ?? tickSeed,
        });
        if (mySeq === reqSeqRef.current) {
          setBundle(res);
        }
      } finally {
        if (mySeq === reqSeqRef.current) {
          inFlightRef.current = false;
        }
        setInitialLoading(false);
      }
    },
    [
      subjectId,
      scenarioId,
      speed,
      forceMockMode,
      pausedLocally,
      mockVisibleWindows,
      mockStreamState,
      mockActiveModel,
      localFeedbackMap,
      tickSeed,
    ]
  );

  // Refresh every 3 seconds as specified in design principles
  useEffect(() => {
    void loadBundle();
    const timer = window.setInterval(() => {
      if (pausedLocally) return;
      setTickSeed((t) => t + 1);
      setMockVisibleWindows((w) => (mockStreamState === "running" ? Math.min(12, w + 1) : w));
    }, 3000);
    return () => window.clearInterval(timer);
  }, [loadBundle, pausedLocally, mockStreamState]);

  // Countdown indicator when reconnecting
  useEffect(() => {
    if (!bundle || bundle.apiConnected || forceMockMode) {
      setRetryCountdown(3);
      return;
    }
    const id = window.setInterval(() => {
      setRetryCountdown((c) => (c <= 1 ? 3 : c - 1));
    }, 1000);
    return () => window.clearInterval(id);
  }, [bundle, forceMockMode]);

  const handleLaunchScenario = async (nextScenario: ScenarioId) => {
    const spec = DEMO_SCENARIOS.find((s) => s.id === nextScenario) ?? DEMO_SCENARIOS[0];
    setActionError(null);
    setScenarioId(nextScenario);
    setSpeed(spec.default_speed);
    setPausedLocally(false);
    setMockStreamState("running");
    setMockVisibleWindows(5);

    // Clear stale previous-session chart immediately on live stack so user sees active loading state
    if (!forceMockMode && bundle?.apiConnected) {
      setBundle((prev) =>
        prev
          ? {
              ...prev,
              personal: {
                ...prev.personal,
                streamState: "starting",
                sparkSeries: [],
                edgeWindows: [],
                events: [],
              },
            }
          : prev
      );
    }

    // Auto-mark demo walkthrough steps
    setChecklist((prev) => ({
      ...prev,
      ranBaseline: prev.ranBaseline || nextScenario === "baseline_calm",
      ranStressAndAlert:
        prev.ranStressAndAlert ||
        nextScenario === "tsst_acute_stress" ||
        nextScenario === "stress_to_recovery",
      ranMotionShield: prev.ranMotionShield || nextScenario === "physical_activity_check",
    }));

    const startRes = await startScenarioOnApi({
      subjectId,
      scenarioId: nextScenario,
      speed: spec.default_speed,
      forceMockMode,
    });
    if (!forceMockMode && !startRes.usedApi && startRes.error) {
      setActionError(startRes.error);
    }
    void loadBundle(tickSeed + 1, {
      force: true,
      subjectId,
      scenarioId: nextScenario,
      speed: spec.default_speed,
    });
  };

  const handleStart = async () => {
    setActionError(null);
    setPausedLocally(false);
    setMockStreamState("running");
    setMockVisibleWindows((w) => (w < 4 ? 5 : w));
    if (!forceMockMode && bundle?.apiConnected) {
      setBundle((prev) =>
        prev
          ? {
              ...prev,
              personal: {
                ...prev.personal,
                streamState: "starting",
                sparkSeries: [],
                edgeWindows: [],
                events: [],
              },
            }
          : prev
      );
    }
    const startRes = await startScenarioOnApi({
      subjectId,
      scenarioId,
      speed,
      forceMockMode,
    });
    if (!forceMockMode && !startRes.usedApi && startRes.error) {
      setActionError(startRes.error);
    }
    void loadBundle(tickSeed + 1, { force: true });
  };

  const handleTogglePause = () => {
    setPausedLocally((prev) => {
      const next = !prev;
      setMockStreamState(next ? "paused" : "running");
      return next;
    });
  };

  const handleStop = async () => {
    setPausedLocally(false);
    setMockStreamState("stopped");
    await stopStreamOnApi(subjectId, forceMockMode);
    void loadBundle(tickSeed + 1);
  };

  const handleFeedback = async (verdict: "ACCURATE" | "FALSE_ALARM") => {
    const winStart =
      bundle?.personal.edgeWindows.at(-1)?.window_start ?? new Date().toISOString();
    setLocalFeedbackMap((prev) => ({
      ...prev,
      [winStart]: {
        verdict,
        note: verdict === "ACCURATE" ? "Người đeo xác nhận đúng" : "Báo nhầm do vận động/cà phê",
      },
    }));
    await submitUserFeedback({
      subjectId,
      windowStart: winStart,
      verdict,
      note: verdict === "ACCURATE" ? "Người đeo xác nhận đúng" : "Báo nhầm",
      forceMockMode,
    });
    void loadBundle(tickSeed + 1);
  };

  const handleActivateModel = async (version: string) => {
    setMockActiveModel(version);
    setChecklist((prev) => ({ ...prev, swappedModel: true }));
    await activateModelVersion(version, forceMockMode);
    await loadBundle(tickSeed + 1);
  };

  const handleInspectTeamMember = (memberSubjectId: string) => {
    setSubjectId(memberSubjectId);
    setActiveTab("personal");
  };

  return (
    <div className="min-h-screen pb-24">
      <div className="mx-auto max-w-[1600px] px-4 py-4 sm:px-6 lg:px-8 space-y-5">
        {/* Global Control Bar */}
        <ControlBar
          activeTab={activeTab}
          onSelectTab={setActiveTab}
          subjectId={subjectId}
          onSelectSubject={(id) => {
            setSubjectId(id);
            setMockVisibleWindows(6);
          }}
          scenarioId={scenarioId}
          onLaunchScenario={(id) => void handleLaunchScenario(id)}
          speed={speed}
          onChangeSpeed={(sp) => setSpeed(sp)}
          streamState={bundle?.personal.streamState ?? mockStreamState}
          onStart={() => void handleStart()}
          onTogglePause={handleTogglePause}
          onStop={() => void handleStop()}
          simulatedClock={bundle?.personal.simulatedClockUtc ?? "--:--:--"}
          services={
            bundle?.system.services ?? {
              kafka: "healthy",
              spark: "healthy",
              edge: "healthy",
              postgres: "healthy",
            }
          }
          usingMockFallback={bundle?.personal.usingMockFallback ?? forceMockMode}
          forceMockMode={forceMockMode}
          onToggleForceMock={() => setForceMockMode((v) => !v)}
          theme={theme}
          onToggleTheme={toggleTheme}
        />

        {/* Action Error Banner (e.g. missing .pkl or model file when clicking Start) */}
        {actionError && !forceMockMode && (
          <div
            role="alert"
            className="rounded-2xl px-4 py-3 text-xs sm:text-sm font-semibold flex flex-wrap items-center justify-between gap-2"
            style={{
              backgroundColor: "var(--crimson-soft)",
              color: "var(--crimson)",
              border: "1px solid var(--crimson)",
            }}
          >
            <span>⚠ Không thể khởi chạy kịch bản trên máy chủ: {actionError}</span>
            <button
              type="button"
              onClick={() => setActionError(null)}
              className="rounded-lg px-3 py-1 text-xs font-extrabold cursor-pointer"
              style={{ backgroundColor: "var(--crimson)", color: "#ffffff" }}
            >
              Đóng
            </button>
          </div>
        )}

        {/* Yellow Auto-Reconnect Banner when Live API is unreachable (unless user explicitly enabled Mock mode) */}
        {bundle && !bundle.apiConnected && !forceMockMode && (
          <div
            role="alert"
            className="rounded-2xl px-4 py-3 text-xs sm:text-sm font-semibold flex flex-wrap items-center justify-between gap-2"
            style={{
              backgroundColor: "var(--amber-soft)",
              color: "var(--amber)",
              border: "1px solid var(--amber)",
            }}
          >
            <span>
              ⚠ Không kết nối được API cổng 8001 ({bundle.errorMessage ?? "mất kết nối"}) — Hệ thống đang tự động hiển thị dữ liệu mô phỏng tại chỗ để không gián đoạn buổi trình bày. Tự động thử kết nối lại sau {retryCountdown}s…
            </span>
            <button
              type="button"
              onClick={() => void loadBundle(tickSeed + 1)}
              className="rounded-lg px-3 py-1 text-xs font-extrabold cursor-pointer"
              style={{ backgroundColor: "var(--amber)", color: "#ffffff" }}
            >
              Thử lại ngay
            </button>
          </div>
        )}

        {/* Skeleton Loading State */}
        {initialLoading || !bundle ? (
          <div className="space-y-4" aria-busy="true" aria-label="Đang tải dữ liệu bảng điều khiển">
            <div className="skeleton-box h-44 w-full" />
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3.5">
              <div className="skeleton-box h-32" />
              <div className="skeleton-box h-32" />
              <div className="skeleton-box h-32" />
              <div className="skeleton-box h-32" />
              <div className="skeleton-box h-32" />
            </div>
            <div className="skeleton-box h-80 w-full" />
          </div>
        ) : (
          <main>
            {activeTab === "personal" && (
              <PersonalTab
                data={bundle.personal}
                onOpenBreathing={() => setBreathingOpen(true)}
                onSendFeedback={(v) => void handleFeedback(v)}
                onStartQuick={() => void handleLaunchScenario("tsst_acute_stress")}
              />
            )}

            {activeTab === "team" && (
              <TeamTab
                data={bundle.team}
                selectedSubjectId={subjectId}
                onInspectMember={handleInspectTeamMember}
              />
            )}

            {activeTab === "system" && (
              <SystemModelTab
                data={bundle.system}
                isFlowing={
                  bundle.personal.streamState === "running" ||
                  bundle.personal.streamState === "starting"
                }
                onActivateModel={handleActivateModel}
              />
            )}
          </main>
        )}
      </div>

      {/* Interactive 4-4-6 Breathing Coach Modal */}
      <BreathingModal
        open={breathingOpen}
        onClose={() => setBreathingOpen(false)}
      />

      {/* 4-Step Auto-Check Demo Guide Corner Widget */}
      <DemoGuideWidget
        completed={checklist}
        onTriggerScenario={(id) => void handleLaunchScenario(id)}
        onSwitchTab={setActiveTab}
      />
    </div>
  );
}
