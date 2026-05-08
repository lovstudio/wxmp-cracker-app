import Auth from "@/pages/Auth"
import { CliAuthorize } from "@/pages/CliAuthorize"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AuthProvider } from "@/hooks/useAuth"

export default function AuthRoutes() {
  return (
    <TooltipProvider>
      <AuthProvider>
        {window.location.pathname === "/cli/authorize" ? (
          <CliAuthorize />
        ) : (
          <Auth />
        )}
      </AuthProvider>
      <Toaster />
    </TooltipProvider>
  )
}
