import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Expo requires React 19.0. Keep the web renderer on that same physical
    // instance so React Three Fiber receives the active React context.
    dedupe: ["react", "react-dom"]
  }
});
