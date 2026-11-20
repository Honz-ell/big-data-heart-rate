import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WESAD Edge Console",
  description: "Mô phỏng, điều khiển thiết bị đeo và theo dõi phát hiện stress.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
