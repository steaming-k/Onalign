import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// 멀티 페이지: index.html = 랜딩(정적), app.html = React 보드 앱
export default defineConfig({
  plugins: [react()],
  server: {
    port: parseInt(process.env.PORT || "5173"),
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        app: resolve(__dirname, "app.html"),
      },
    },
  },
});
