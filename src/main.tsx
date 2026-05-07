import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import App from "./App.tsx"
import { ThemeProvider } from "@/components/theme-provider.tsx"

const themeStorageKey = "weitan-theme-v1"

if (!localStorage.getItem(themeStorageKey)) {
  localStorage.setItem(themeStorageKey, "light")
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="light" storageKey={themeStorageKey}>
      <main data-ui-scroll-container>
        <App />
      </main>
    </ThemeProvider>
  </StrictMode>
)
