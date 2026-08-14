import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";

// Vite 配置项说明：https://vite.dev/config/
export default defineConfig({
  plugins: [tailwindcss(), react()],
});
