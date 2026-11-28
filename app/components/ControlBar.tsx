"use client";

import React from "react";
import { DEMO_SCENARIOS, WESAD_SUBJECTS } from "../lib/mockEngine";
import {
  DashboardTab,
  ScenarioId,
  ServiceHealth,
} from "../lib/types";

function HealthPill({
  name,
  status,
}: {
  name: string;
  status: ServiceHealth;
}) {
  const map: Record<
    ServiceHealth,
    { color: string; bg: string; symbol: string; label: string }
  > = {
    healthy: {
      color: "var(--emerald)",
      bg: "var(--emerald-soft)",
      symbol: "●",
      label: "Hoạt động",
    },
    idle: {
      color: "var(--amber)",
      bg: "var(--amber-soft)",
      symbol: "◐",
      label: "Chờ luồng",
    },
    degraded: {
      color: "var(--amber)",
      bg: "var(--amber-soft)",
      symbol: "▲",
      label: "Chậm/Mô phỏng",
    },
    down: {
      color: "var(--crimson)",
      bg: "var(--crimson-soft)",
      symbol: "✕",
      label: "Ngắt kết nối",
    },
  };
  const cfg = map[status] ?? map.idle;

  return (
    <span
      title={`${name}: ${cfg.label}`}
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold"
      style={{
        backgroundColor: cfg.bg,
        color: cfg.color,
        border: `1px solid ${cfg.color}33`,
      }}
    >
      <span aria-hidden="true">{cfg.symbol}</span>
      <span>{name}</span>
    </span>
  );
}

export function ControlBar({
  activeTab,
  onSelectTab,
  subjectId,
  onSelectSubject,
  scenarioId,
  onLaunchScenario,
  speed,
  onChangeSpeed,
  streamState,
  onStart,
  onTogglePause,
  onStop,
  simulatedClock,
  services,
  usingMockFallback,
  forceMockMode,
  onToggleForceMock,
  theme,
  onToggleTheme,
}: {
  activeTab: DashboardTab;
  onSelectTab: (tab: DashboardTab) => void;
  subjectId: string;
  onSelectSubject: (id: string) => void;
  scenarioId: ScenarioId;
  onLaunchScenario: (id: ScenarioId) => void;
  speed: number;
  onChangeSpeed: (speed: number) => void;
  streamState: "running" | "paused" | "stopped" | "starting";
  onStart: () => void;
  onTogglePause: () => void;
  onStop: () => void;
  simulatedClock: string;
  services: {
    kafka: ServiceHealth;
    spark: ServiceHealth;
    edge: ServiceHealth;
    postgres: ServiceHealth;
  };
  usingMockFallback: boolean;
  forceMockMode: boolean;
  onToggleForceMock: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}) {
  const speeds = [1, 10, 30, 60];

  const toneAccent: Record<string, string> = {
    calm: "var(--emerald)",
    stress: "var(--crimson)",
    recovery: "var(--sky)",
    motion: "var(--amber)",
  };

  return (
    <header className="space-y-3">
      {/* Top Sticky Control Bar */}
      <div className="surface-card px-4 py-3.5 lg:px-6">
        {/* Row A: Brand + 3-Tab Switcher + Pipeline Badges + Theme/Mock Switch */}
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b" style={{ borderColor: "var(--border)" }}>
          <div className="flex items-center gap-3">
            <div
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl font-black text-white text-base shadow-sm"
              style={{ background: "linear-gradient(135deg, var(--emerald), var(--sky))" }}
            >
              E4
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-lg sm:text-xl font-extrabold tracking-tight" style={{ color: "var(--ink)" }}>
                  WESAD Stress Edge
                </h1>
                {usingMockFallback && (
                  <span
                    className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold"
                    style={{
                      backgroundColor: "var(--amber-soft)",
                      color: "var(--amber)",
                      border: "1px solid var(--amber)",
                    }}
                  >
                    ⚡ Đang dùng dữ liệu mô phỏng
                  </span>
                )}
              </div>
              <p className="text-xs" style={{ color: "var(--muted)" }}>
                Nguyên mẫu học tập, dữ liệu phát lại từ WESAD, không dùng chẩn đoán y tế.
              </p>
            </div>
          </div>

          {/* 3-Tab Switcher */}
          <nav
            aria-label="Chế độ xem đối tượng người dùng"
            className="flex flex-wrap items-center gap-1 rounded-xl p-1"
            style={{ backgroundColor: "var(--surface-2)", border: "1px solid var(--border)" }}
          >
            {(
              [
                { id: "personal", label: "1. Cá nhân (Người đeo)" },
                { id: "team", label: "2. Theo dõi nhóm / Quản lý" },
                { id: "system", label: "3. Hệ thống & Model" },
              ] as { id: DashboardTab; label: string }[]
            ).map((tab) => {
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => onSelectTab(tab.id)}
                  className="rounded-lg px-3.5 py-2 text-sm font-bold transition-all cursor-pointer"
                  style={{
                    backgroundColor: active ? "var(--surface)" : "transparent",
                    color: active ? "var(--ink)" : "var(--muted)",
                    boxShadow: active ? "0 1px 3px rgba(0,0,0,0.12)" : "none",
                  }}
                >
                  {tab.label}
                </button>
              );
            })}
          </nav>

          {/* Pipeline Health + Mode & Theme */}
          <div className="flex flex-wrap items-center gap-1.5">
            <HealthPill name="Kafka" status={services.kafka} />
            <HealthPill name="Spark" status={services.spark} />
            <HealthPill name="Edge" status={services.edge} />
            <HealthPill name="PostgreSQL" status={services.postgres} />

            <button
              type="button"
              onClick={onToggleForceMock}
              title="Bật/tắt chế độ dữ liệu mô phỏng tại chỗ (không phụ thuộc API ngoài)"
              className="ml-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold cursor-pointer transition-colors"
              style={{
                backgroundColor: forceMockMode ? "var(--amber-soft)" : "var(--surface-2)",
                color: forceMockMode ? "var(--amber)" : "var(--ink-2)",
                border: "1px solid var(--border)",
              }}
            >
              {forceMockMode ? "Mô phỏng: BẬT" : "Nguồn: Tự động"}
            </button>

            <button
              type="button"
              onClick={onToggleTheme}
              aria-label="Chuyển giao diện Sáng / Tối"
              className="rounded-lg px-2.5 py-1.5 text-xs font-semibold cursor-pointer"
              style={{
                backgroundColor: "var(--surface-2)",
                color: "var(--ink)",
                border: "1px solid var(--border)",
              }}
            >
              {theme === "dark" ? "☀ Nền sáng" : "🌙 Nền tối"}
            </button>
          </div>
        </div>

        {/* Row B: Participant Selector + Scenario Dropdown + Speed Slider + Start/Pause/Stop + Clock */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            {/* Participant Dropdown */}
            <label className="flex items-center gap-2 text-sm font-medium" style={{ color: "var(--ink-2)" }}>
              <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
                Người đeo:
              </span>
              <select
                value={subjectId}
                onChange={(e) => onSelectSubject(e.target.value)}
                className="rounded-xl px-3 py-1.5 text-sm font-bold cursor-pointer outline-none"
                style={{
                  backgroundColor: "var(--surface-2)",
                  color: "var(--ink)",
                  border: "1px solid var(--border-strong)",
                }}
              >
                {WESAD_SUBJECTS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id} ({s.anonCode}) — {s.role}
                  </option>
                ))}
              </select>
            </label>

            {/* Scenario Dropdown */}
            <label className="flex items-center gap-2 text-sm font-medium" style={{ color: "var(--ink-2)" }}>
              <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
                Kịch bản:
              </span>
              <select
                value={scenarioId}
                onChange={(e) => onLaunchScenario(e.target.value as ScenarioId)}
                className="rounded-xl px-3 py-1.5 text-sm font-bold cursor-pointer outline-none"
                style={{
                  backgroundColor: "var(--surface-2)",
                  color: "var(--ink)",
                  border: "1px solid var(--border-strong)",
                }}
              >
                {DEMO_SCENARIOS.map((sc) => (
                  <option key={sc.id} value={sc.id}>
                    {sc.stepNumber}. {sc.title}
                  </option>
                ))}
              </select>
            </label>

            {/* Speed Slider / Pills */}
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
                Tốc độ phát:
              </span>
              <div
                className="inline-flex rounded-xl p-0.5"
                style={{ backgroundColor: "var(--surface-2)", border: "1px solid var(--border)" }}
              >
                {speeds.map((sp) => (
                  <button
                    key={sp}
                    type="button"
                    onClick={() => onChangeSpeed(sp)}
                    className="rounded-lg px-2.5 py-1 text-xs font-bold tabular-nums cursor-pointer transition-colors"
                    style={{
                      backgroundColor: speed === sp ? "var(--sky)" : "transparent",
                      color: speed === sp ? "#ffffff" : "var(--muted)",
                    }}
                  >
                    {sp}×
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Transport Controls + Simulated Replay Clock */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onStart}
              className="inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-bold text-white shadow-sm cursor-pointer transition-opacity hover:opacity-90"
              style={{ backgroundColor: "var(--emerald)" }}
            >
              ▶ Start
            </button>
            <button
              type="button"
              onClick={onTogglePause}
              className="inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-bold cursor-pointer"
              style={{
                backgroundColor: streamState === "paused" ? "var(--amber-soft)" : "var(--surface-2)",
                color: streamState === "paused" ? "var(--amber)" : "var(--ink)",
                border: "1px solid var(--border-strong)",
              }}
            >
              {streamState === "paused" ? "▶ Tiếp tục" : "⏸ Pause"}
            </button>
            <button
              type="button"
              onClick={onStop}
              className="inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-bold cursor-pointer"
              style={{
                backgroundColor: "var(--surface-2)",
                color: "var(--ink-2)",
                border: "1px solid var(--border-strong)",
              }}
            >
              ⏹ Stop
            </button>

            <div
              className="ml-1 flex items-center gap-2 rounded-xl px-3.5 py-1.5"
              style={{ backgroundColor: "var(--surface-2)", border: "1px solid var(--border)" }}
            >
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{
                  backgroundColor:
                    streamState === "running" || streamState === "starting"
                      ? "var(--emerald)"
                      : streamState === "paused"
                        ? "var(--amber)"
                        : "var(--muted)",
                }}
              />
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
                  Giờ mô phỏng WESAD
                </div>
                <div className="text-sm font-extrabold tabular-nums" style={{ color: "var(--ink)" }}>
                  {simulatedClock} UTC
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 1-Click Scenario Bar (4 Large Projector-Friendly Buttons) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        {DEMO_SCENARIOS.map((sc) => {
          const isSelected = scenarioId === sc.id;
          const accent = toneAccent[sc.tone] ?? "var(--sky)";
          return (
            <button
              key={sc.id}
              type="button"
              onClick={() => onLaunchScenario(sc.id)}
              className="surface-card text-left p-3.5 cursor-pointer transition-all hover:-translate-y-0.5"
              style={{
                borderColor: isSelected ? accent : "var(--border)",
                borderWidth: isSelected ? "2px" : "1px",
              }}
            >
              <div className="flex items-center justify-between gap-2 mb-1">
                <span
                  className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold"
                  style={{ backgroundColor: `${accent}1F`, color: accent }}
                >
                  Kịch bản {sc.stepNumber}
                </span>
                <span className="text-xs font-semibold tabular-nums" style={{ color: "var(--muted)" }}>
                  {sc.duration_seconds}s · {sc.default_speed}×
                </span>
              </div>
              <div className="text-base font-extrabold leading-snug" style={{ color: "var(--ink)" }}>
                {sc.title}
              </div>
              <div className="mt-1 text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
                {sc.shortDesc}
              </div>
            </button>
          );
        })}
      </div>
    </header>
  );
}
