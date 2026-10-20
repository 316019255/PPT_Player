import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "在线 PPT 播放器 - 大屏全屏演示",
  description: "在线创建、编辑、播放 PPT，支持图片视频背景和大屏全屏放映",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="min-h-dvh bg-[#0f0f14] text-[#e0e0e0]">{children}</body>
    </html>
  );
}
