import type { NextConfig } from "next";

/**
 * The backend is reached through this server, not by the browser directly.
 *
 * Every API call the app makes is a relative path (`/api/v2/...`), so the
 * browser only ever talks to the origin it loaded the page from. Next forwards
 * those requests to the FastAPI backend server-side. That means the app works
 * unchanged however you reach it — localhost on this box, the box's LAN address
 * from another machine, or through an SSH tunnel — because "where the API
 * lives" is answered here rather than baked into the browser bundle.
 *
 * It also means the backend does not have to listen on the network at all; it
 * only has to be reachable from this process.
 */
const API_PROXY_TARGET = process.env.API_PROXY_TARGET ?? "http://localhost:8000";

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  experimental: {
    // Parse, claim extraction, map generation, chat and the agent loop all run
    // inside the HTTP request today — minutes, not seconds. Next's rewrite
    // proxy gives up at 30s by default and returns a 500, which would kill
    // exactly those calls. Five minutes matches what the backend can take.
    proxyTimeout: 300_000,
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${API_PROXY_TARGET}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
