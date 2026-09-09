import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The backend serves /v1 and /v2 from FastAPI on port 8000. Proxying them in
// dev keeps the app on one origin, so no CORS and no absolute URLs in code.
// Point at someone else's machine with:
//   BEACON_API=https://<tunnel-host> npm run dev
const BACKEND = process.env.BEACON_API || 'http://127.0.0.1:8000'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/v1': { target: BACKEND, changeOrigin: true },
      '/v2': { target: BACKEND, changeOrigin: true },
    },
  },
})
