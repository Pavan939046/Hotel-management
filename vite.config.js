import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        menu: "index.html",
        staff: "staff.html",
        adminPortal: "admin-portal.html",
        supervisorPortal: "supervisor-portal.html",
      },
    },
  },
});
