"use client";

import React, { useState } from "react";
import { DashboardTab, ScenarioId } from "../lib/types";

export interface DemoChecklistState {
  ranBaseline: boolean;
  ranStressAndAlert: boolean;
  ranMotionShield: boolean;
  swappedModel: boolean;
}

export function DemoGuideWidget({
  completed,
  onTriggerScenario,
  onSwitchTab,
}: {
  completed: DemoChecklistState;
  onTriggerScenario: (id: ScenarioId) => void;
  onSwitchTab: (tab: DashboardTab) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  const steps = [
    {
      key: "step1",
      done: completed.ranBaseline,
      title: "1. Trạng thái nền (Làm việc thư giãn)",
      hint: "Cho hội đồng thấy mức nghỉ ổn định (Xanh).",
      actionLabel: "Chạy ngay",
      onClick: () => {
        onSwitchTab("personal");
        onTriggerScenario("baseline_calm");
      },
    },
    {
      key: "step2",
      done: completed.ranStressAndAlert,
      title: "2. Phát hiện Stress cấp (TSST)",
      hint: "EDA & BPM tăng vọt → Cảnh báo đỏ + Gợi ý thở 4-4-6.",
      actionLabel: "Chạy TSST",
      onClick: () => {
        onSwitchTab("personal");
        onTriggerScenario("tsst_acute_stress");
      },
    },
    {
      key: "step3",
      done: completed.ranMotionShield,
      title: "3. Đi bộ nhanh (Chặn báo giả)",
      hint: "Khoảnh khắc WOW: BPM cao nhưng KHÔNG báo nhầm stress.",
      actionLabel: "Thử vận động",
      onClick: () => {
        onSwitchTab("personal");
        onTriggerScenario("physical_activity_check");
      },
    },
    {
      key: "step4",
      done: completed.swappedModel,
      title: "4. Hot-Swap Model sống (Tab 3)",
      hint: "Chuyển nóng v1.0.0 ↔ v1.1.0 không dừng luồng Kafka.",
      actionLabel: "Mở Tab 3",
      onClick: () => {
        onSwitchTab("system");
      },
    },
  ];

  const doneCount = steps.filter((s) => s.done).length;

  return (
    <aside
      aria-label="Hướng dẫn kịch bản trình bày 4 bước"
      className="fixed bottom-4 right-4 z-40 w-80 max-w-[calc(100vw-2rem)] surface-card overflow-hidden"
      style={{
        border: "1px solid var(--border-strong)",
      }}
    >
      <div
        className="flex items-center justify-between px-4 py-2.5 cursor-pointer"
        style={{ backgroundColor: "var(--surface-2)" }}
        onClick={() => setCollapsed((c) => !c)}
      >
        <div className="flex items-center gap-2">
          <span
            className="inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold text-white"
            style={{ backgroundColor: doneCount === 4 ? "var(--emerald)" : "var(--sky)" }}
          >
            {doneCount}/4
          </span>
          <div>
            <div className="text-xs font-bold" style={{ color: "var(--ink)" }}>
              Hướng dẫn Demo Báo cáo
            </div>
            <div className="text-[11px]" style={{ color: "var(--muted)" }}>
              Tự động đánh dấu khi thao tác
            </div>
          </div>
        </div>
        <button
          type="button"
          className="rounded-md px-2 py-0.5 text-xs font-semibold cursor-pointer"
          style={{ color: "var(--muted)", backgroundColor: "var(--surface-3)" }}
        >
          {collapsed ? "Mở ▲" : "Thu gọn ▼"}
        </button>
      </div>

      {!collapsed && (
        <div className="divide-y p-2.5 space-y-1.5" style={{ borderColor: "var(--border)" }}>
          {steps.map((step) => (
            <div key={step.key} className="pt-1.5 first:pt-0 flex items-start justify-between gap-2">
              <div className="flex items-start gap-2 min-w-0">
                <span
                  className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold"
                  style={{
                    backgroundColor: step.done ? "var(--emerald)" : "var(--surface-3)",
                    color: step.done ? "#ffffff" : "var(--muted)",
                  }}
                >
                  {step.done ? "✓" : "•"}
                </span>
                <div className="min-w-0">
                  <div
                    className="text-xs font-semibold leading-snug"
                    style={{
                      color: "var(--ink)",
                      textDecoration: step.done ? "line-through" : "none",
                      opacity: step.done ? 0.72 : 1,
                    }}
                  >
                    {step.title}
                  </div>
                  <div className="text-[11px] leading-tight mt-0.5" style={{ color: "var(--muted)" }}>
                    {step.hint}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={step.onClick}
                className="shrink-0 rounded-lg px-2 py-1 text-[11px] font-semibold cursor-pointer transition-opacity hover:opacity-90"
                style={{
                  backgroundColor: "var(--sky-soft)",
                  color: "var(--sky)",
                }}
              >
                {step.actionLabel}
              </button>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
