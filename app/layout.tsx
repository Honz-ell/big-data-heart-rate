import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WESAD Pulse & Stress Companion — Giám sát Nhịp tim & Căng thẳng Đa cảm biến",
  description:
    "Hệ thống phân tích luồng dữ liệu đeo tay Empatica E4: theo dõi nhịp tim (BPM), HRV, dẫn điện da (EDA), phát hiện căng thẳng kéo dài và vận hành mô hình Edge AI với Apache Kafka & Spark Structured Streaming.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
