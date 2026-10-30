import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

// 独立于 vite.config.ts：后者加载了 @cloudflare/vite-plugin，vitest 用不上也不需要。
// 但 alias 要手动补上，否则 src 里 `@/...` 的引用解析不了。
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    // 后端纯函数 + 前端里不依赖 DOM 的工具函数
    include: ['server/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
