import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from "react"
import { isTauri } from "@/lib/tauri"
import { Website } from "@/pages/Website"

const WorkspaceShell = lazy(() => import("@/WorkspaceApp"))
const PublicAuthRoutes = lazy(() => import("@/pages/AuthRoutes"))

export default function App() {
  if (!isTauri() && isPublicAuthRoute()) {
    return (
      <Suspense fallback={<div className="app-loading-screen">正在打开登录</div>}>
        <PublicAuthRoutes />
      </Suspense>
    )
  }

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

function isPublicAuthRoute() {
  return (
    window.location.pathname === "/auth" ||
    window.location.pathname === "/cli/authorize"
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
