import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          AUTH_SECRET: "test-secret-that-is-long-enough-for-authjs",
          AUTH_COOKIE_DOMAIN: "",
          AUTH_GOOGLE_ID: "test-google-client-id",
          AUTH_GOOGLE_SECRET: "test-google-client-secret",
          AUTH_APPLE_ID: "test.apple.service-id",
          AUTH_APPLE_SECRET: "test-apple-client-secret",
        },
      },
    }),
  ],
});
