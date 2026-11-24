import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),

    VitePWA({
      registerType: "prompt",

      strategies: "generateSW",

      injectRegister: "auto",

      includeAssets: [
        "icons/app-icon.svg",
        "icons/icon-192.png",
        "icons/icon-512.png",
        "icons/apple-touch-icon.png"
      ],

      manifest: {
        id: "/",
        name: "Food Manufacturing Management System",
        short_name: "Food Manufacturing",
        description:
          "Food manufacturing operations, inventory, production, sales, invoicing, and offline sales order management.",

        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "any",

        theme_color: "#3F4E5C",
        background_color: "#EDEFF2",

        icons: [
          {
            src: "/icons/app-icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any"
          },
          {
            src: "/icons/icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any"
          },
          {
            src: "/icons/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any"
          }
        ]
      },

      workbox: {
        globPatterns: [
          "**/*.{js,css,html,svg,png,ico,woff,woff2}"
        ],

        globIgnores: [
          "**/*.map"
        ],

        navigateFallback: "/index.html",

        navigateFallbackDenylist: [
          /^\/api(?:\/|$)/,
          /^\/docs(?:\/|$)/,
          /^\/redoc(?:\/|$)/,
          /^\/openapi\.json$/
        ],

        cleanupOutdatedCaches: true,

        clientsClaim: false,
        skipWaiting: false,

        runtimeCaching: [],

        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024
      },

      devOptions: {
        enabled: false
      }
    })
  ],

  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true
  },

  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true
  },

  build: {
    target: "es2022",
    outDir: "dist",
    assetsDir: "assets",
    sourcemap: false,
    emptyOutDir: true
  }
});