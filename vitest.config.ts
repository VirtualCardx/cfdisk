import { defineConfig } from 'vitest/config';

// 独立于 vite.config.ts：后者加载了 @cloudflare/vite-plugin，vitest 用不上也不需要
export default defineConfig({
  test: {
    environment: 'node',
    // 后端纯函数 + 前端里不依赖 DOM 的工具函数
    include: ['server/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
