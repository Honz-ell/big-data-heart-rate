import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WESAD Stress Edge — Dashboard Giám sát Căng thẳng & Big Data Thời gian thực",
  description:
    "Nguyên mẫu học tập phát lại dữ liệu cảm biến đồng hồ Empatica E4 (WESAD) qua Kafka, Spark Structured Streaming (10s), PostgreSQL và Edge Random Forest (30s Hot-Swap). Không dùng chẩn đoán y tế.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="vi" data-theme="dark" suppressHydrationWarning>
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
