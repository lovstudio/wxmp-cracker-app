import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from "react"
import { Website } from "@/pages/Website"
import { isTauri } from "@/lib/tauri"

const WorkspaceShell = lazy(() => import("@/WorkspaceApp"))

export default function App() {
  if (!isTauri() && !isWorkspacePreviewRoute()) {
    return <Website />
  }

  return (
    <WorkspaceErrorBoundary>
      <Suspense fallback={<div className="app-loading-screen">正在启动微探</div>}>
        <WorkspaceShell />
      </Suspense>
    </WorkspaceErrorBoundary>
  )
}

function isWorkspacePreviewRoute() {
  return (
    window.location.pathname === "/workspace-preview" ||
    window.location.search.includes("workspace=1")
  )
}

class WorkspaceErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Workspace failed to start", error, info)
  }

  render() {
    if (!this.state.error) {
      return this.props.children
    }

    return (
      <div className="app-loading-screen app-error-screen">
        <div>
          <h1>微探启动失败</h1>
          <p>{this.state.error.message}</p>
        </div>
      </div>
    )
  }
}
