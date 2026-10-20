import type { NextConfig } from "next";
import path from "path";

// 公网部署的最小响应头：不改变现有行为，只关掉这个应用用不到的能力
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'same-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
  },
  // 左下角那个浮标是 Next 开发模式的角标（DOM 里的 <nextjs-portal>），只在 next dev 出现。
  // 生产构建本来就没有它；关掉是为了本地看界面时不误认成网站的东西。
  devIndicators: false,
  async headers() {
    return [{ source: '/(.*)', headers: securityHeaders }];
  },
};

export default nextConfig;
