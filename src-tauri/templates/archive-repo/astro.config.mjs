import { defineConfig } from "astro/config";

// Update `site` after enabling GitHub Pages for this repo.
export default defineConfig({
  site: "https://example.github.io",
  markdown: {
    shikiConfig: { theme: "github-light" },
  },
});
