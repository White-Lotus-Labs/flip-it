import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    fs: { deny: ['.env', '.env.*', '**/.git/**', '**/.near-credentials/**'] },
  },
})
