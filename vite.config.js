import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// 멀티 페이지: index.html = 랜딩(정적), app.html = React 보드 앱,
// terms/privacy.html = 약관·방침(정적). rollupOptions.input에 등록하지 않으면 dist에 복사되지 않아
// 배포 후 404가 되므로, 루트에 정적 페이지를 새로 추가할 때는 여기에도 반드시 함께 넣어야 한다.
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
        terms: resolve(__dirname, "terms.html"),
        privacy: resolve(__dirname, "privacy.html"),
      },
    },
  },
});
