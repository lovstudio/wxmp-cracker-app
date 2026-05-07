import { useMemo, useState, type FormEvent } from "react"
import { Loader2, LockKeyhole, LogIn, Mail } from "lucide-react"
import { z } from "zod"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useAuth } from "@/hooks/useAuth"

type AuthMode = "sign-in" | "sign-up" | "reset" | "update-password"

const emailSchema = z.string().trim().email("Enter a valid email address.")
const passwordSchema = z
  .string()
  .min(8, "Use at least 8 characters for the password.")
const displayNameSchema = z.string().trim().max(80).optional()

export default function Auth() {
  const params = useMemo(() => new URLSearchParams(window.location.search), [])
  const initialMode =
    params.get("mode") === "update-password" ? "update-password" : "sign-in"
  const redirectTarget = useMemo(
    () => safeRedirectTarget(params.get("redirect")),
    [params]
  )
  const verified = params.get("verified") === "true"
  const {
    user,
    isLoading,
    signIn,
    signUp,
    signInWithGoogle,
    signOut,
    resetPassword,
    updatePassword,
    resendVerificationEmail,
  } = useAuth()
  const [mode, setMode] = useState<AuthMode>(initialMode)
  const [email, setEmail] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [status, setStatus] = useState<string | null>(
    verified ? "Email verified. You can sign in now." : null
  )
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const title = modeTitle(mode)
  const showPassword = mode !== "reset"
  const showConfirm = mode === "sign-up" || mode === "update-password"
  const showEmail = mode !== "update-password"

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setStatus(null)
    setSubmitting(true)

    try {
      const validEmail = showEmail ? emailSchema.parse(email) : ""
      const validPassword = showPassword ? passwordSchema.parse(password) : ""

      if (showConfirm && validPassword !== confirmPassword) {
        throw new Error("Passwords do not match.")
      }

      if (mode === "sign-in") {
        await signIn(validEmail, validPassword)
        window.location.assign(redirectTarget)
        return
      }

      if (mode === "sign-up") {
        const validDisplayName =
          displayNameSchema.parse(displayName) || undefined
        await signUp(validEmail, validPassword, validDisplayName)
        setStatus("Check your inbox to verify your email address.")
        return
      }

      if (mode === "reset") {
        await resetPassword(validEmail)
        setStatus("Password reset email sent.")
        return
      }

      await updatePassword(validPassword)
      setStatus("Password updated.")
      setPassword("")
      setConfirmPassword("")
      window.setTimeout(() => window.location.assign(redirectTarget), 600)
    } catch (caughtError) {
      setError(errorMessage(caughtError))
    } finally {
      setSubmitting(false)
    }
  }

  const handleGoogleSignIn = async () => {
    setError(null)
    setStatus(null)
    setSubmitting(true)

    try {
      await signInWithGoogle(authRedirectUrl(redirectTarget))
    } catch (caughtError) {
      setError(errorMessage(caughtError))
      setSubmitting(false)
    }
  }

  const handleResendVerification = async () => {
    setError(null)
    setStatus(null)

    try {
      const validEmail = emailSchema.parse(email)
      await resendVerificationEmail(validEmail)
      setStatus("Verification email sent.")
    } catch (caughtError) {
      setError(errorMessage(caughtError))
    }
  }

  if (isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-6">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (user && mode !== "update-password") {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Signed in</CardTitle>
            <CardDescription>{user.email}</CardDescription>
          </CardHeader>
          <CardFooter className="gap-2">
            <Button
              className="flex-1"
              type="button"
              onClick={() => window.location.assign(redirectTarget)}
            >
              Continue
            </Button>
            <Button
              className="flex-1"
              type="button"
              variant="outline"
              onClick={() => void signOut()}
            >
              Sign out
            </Button>
          </CardFooter>
        </Card>
      </main>
    )
  }

  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{modeDescription(mode)}</CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="grid gap-4">
            {status ? (
              <p className="rounded-lg border border-primary/25 bg-primary/10 px-3 py-2 text-sm text-primary">
                {status}
              </p>
            ) : null}
            {error ? (
              <p className="rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {showEmail ? (
              <div className="grid gap-2">
                <Label htmlFor="auth-email">Email</Label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="auth-email"
                    autoComplete="email"
                    className="pl-8"
                    disabled={submitting}
                    inputMode="email"
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="you@example.com"
                    type="email"
                    value={email}
                  />
                </div>
              </div>
            ) : null}
            {mode === "sign-up" ? (
              <div className="grid gap-2">
                <Label htmlFor="auth-display-name">Display name</Label>
                <Input
                  id="auth-display-name"
                  autoComplete="name"
                  disabled={submitting}
                  onChange={(event) => setDisplayName(event.target.value)}
                  type="text"
                  value={displayName}
                />
              </div>
            ) : null}
            {showPassword ? (
              <div className="grid gap-2">
                <Label htmlFor="auth-password">Password</Label>
                <div className="relative">
                  <LockKeyhole className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="auth-password"
                    autoComplete={
                      mode === "sign-in" ? "current-password" : "new-password"
                    }
                    className="pl-8"
                    disabled={submitting}
                    onChange={(event) => setPassword(event.target.value)}
                    type="password"
                    value={password}
                  />
                </div>
              </div>
            ) : null}
            {showConfirm ? (
              <div className="grid gap-2">
                <Label htmlFor="auth-confirm-password">Confirm password</Label>
                <Input
                  id="auth-confirm-password"
                  autoComplete="new-password"
                  disabled={submitting}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  type="password"
                  value={confirmPassword}
                />
              </div>
            ) : null}
            <Button className="w-full" disabled={submitting} type="submit">
              {submitting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                primaryAction(mode)
              )}
            </Button>
            {mode !== "update-password" ? (
              <>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <div className="h-px flex-1 bg-border" />
                  or
                  <div className="h-px flex-1 bg-border" />
                </div>
                <Button
                  className="w-full"
                  disabled={submitting}
                  onClick={handleGoogleSignIn}
                  type="button"
                  variant="outline"
                >
                  <LogIn />
                  Continue with Google
                </Button>
              </>
            ) : null}
          </CardContent>
        </form>
        <CardFooter className="flex-col items-stretch gap-2">
          {mode === "sign-in" ? (
            <>
              <Button
                disabled={submitting}
                onClick={() => setMode("reset")}
                type="button"
                variant="ghost"
              >
                Forgot password
              </Button>
              <Button
                disabled={submitting}
                onClick={() => setMode("sign-up")}
                type="button"
                variant="ghost"
              >
                Create an account
              </Button>
              <Button
                disabled={submitting || !email}
                onClick={handleResendVerification}
                type="button"
                variant="ghost"
              >
                Resend verification email
              </Button>
            </>
          ) : null}
          {mode !== "sign-in" && mode !== "update-password" ? (
            <Button
              disabled={submitting}
              onClick={() => setMode("sign-in")}
              type="button"
              variant="ghost"
            >
              Back to sign in
            </Button>
          ) : null}
        </CardFooter>
      </Card>
    </main>
  )
}

function modeTitle(mode: AuthMode) {
  if (mode === "sign-up") return "Create account"
  if (mode === "reset") return "Reset password"
  if (mode === "update-password") return "Update password"

  return "Sign in"
}

function modeDescription(mode: AuthMode) {
  if (mode === "sign-up") return "Use email or Google to create an account."
  if (mode === "reset") return "Send a reset link to your email address."
  if (mode === "update-password") return "Choose a new password."

  return "Use your LovStudio account."
}

function primaryAction(mode: AuthMode) {
  if (mode === "sign-up") return "Create account"
  if (mode === "reset") return "Send reset link"
  if (mode === "update-password") return "Update password"

  return "Sign in"
}

function safeRedirectTarget(value: string | null) {
  if (!value) return "/"

  try {
    const target = new URL(value, window.location.origin)

    if (target.origin !== window.location.origin) {
      return "/"
    }

    return `${target.pathname}${target.search}${target.hash}`
  } catch {
    return "/"
  }
}

function authRedirectUrl(redirectTarget: string) {
  const params = new URLSearchParams()
  params.set("redirect", redirectTarget)

  return `${window.location.origin}/auth?${params.toString()}`
}

function errorMessage(error: unknown) {
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? "Invalid form input."
  }

  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}
