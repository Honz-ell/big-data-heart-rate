import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WESAD Stress Lab — Phân tích dữ liệu cảm biến đeo",
  description:
    "Mô phỏng phát lại dữ liệu WESAD qua Kafka và Spark, phân loại Stress/Non-Stress và trực quan hóa tín hiệu HR, IBI, EDA, nhiệt độ và gia tốc. Không phải công cụ chẩn đoán sức khỏe.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
