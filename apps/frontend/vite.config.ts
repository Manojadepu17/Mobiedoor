import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  if (command === "build" && mode === "production" && env.VITE_API_URL?.trim() !== "/api") {
    throw new Error('VITE_API_URL must be exactly "/api" for production builds.');
  }
  return {
    plugins: [react()],
    server: {
      port: 5173,
    },
  };
});
