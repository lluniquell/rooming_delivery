import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Vercel이 빌드 시 자동으로 넣어주는 커밋 SHA — 헤더에 배포 버전 표시용
const buildId = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? `local-${Date.now()}`

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
})
