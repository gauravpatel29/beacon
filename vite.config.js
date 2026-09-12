import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// The backend serves /v1 and /v2 from FastAPI on port 8000. Proxying them in
// dev keeps the app on one origin, so no CORS and no absolute URLs in code.
// Point at someone else's machine with either:
//   BEACON_API=https://<tunnel-host> npm run dev
//   BEACON_API=https://<tunnel-host>   in .env.local
//
// To skip the proxy entirely (deploys, or talking straight to a remote API),
// set VITE_API_BASE_URL instead — see Apiconfig.js.
export default defineConfig(({ mode }) => {
  // '' as the prefix means "no filter", so BEACON_API is picked up alongside
  // the VITE_* vars. This is config-only; nothing here reaches the client
  // bundle, which still sees just the VITE_* vars Vite inlines.
  const env = loadEnv(mode, process.cwd(), '')
  const BACKEND = env.BEACON_API || 'http://127.0.0.1:8000'

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/v1': { target: BACKEND, changeOrigin: true },
        '/v2': { target: BACKEND, changeOrigin: true },
        // Data Review's engines. Same FastAPI app, older prefix: these take the
        // CSV in the body rather than resolving a dataset by name, which is
        // what lets the screen analyse a row set the user has filtered locally.
        '/api': { target: BACKEND, changeOrigin: true },
      },
    },
  }
})
