import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import type { Session, User } from "@supabase/supabase-js"
import { useAtom } from "jotai"

import { supabase } from "@/integrations/supabase/client"
import type { Tables } from "@/integrations/supabase/types"
import { guestModeAtom } from "@/store/authAtoms"

export type Profile = Tables<"profiles">

type AuthContextValue = {
  user: User | null
  session: Session | null
  profile: Profile | null
  isLoading: boolean
  isAdmin: boolean
  isActualAdmin: boolean
  guestMode: boolean
  setGuestMode: (enabled: boolean) => void
  refreshProfile: () => Promise<void>
  signUp: (
    email: string,
    password: string,
    displayName?: string
  ) => Promise<void>
  signIn: (email: string, password: string) => Promise<void>
  signInWithEmailOtp: (email: string, redirectTo?: string) => Promise<void>
  signInWithGoogle: (redirectTo?: string) => Promise<void>
  signInWithGoogleIdToken: (credential: string, nonce: string) => Promise<void>
  getGoogleSignInUrl: (redirectTo?: string) => Promise<string>
  completeOAuthFromUrl: (url: string) => Promise<void>
  completeTokenSession: (
    accessToken: string,
    refreshToken: string
  ) => Promise<void>
  signOut: () => Promise<void>
  resetPassword: (email: string) => Promise<void>
  updatePassword: (password: string) => Promise<void>
  resendVerificationEmail: (email: string) => Promise<void>
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isActualAdmin, setIsActualAdmin] = useState(false)
  const [guestMode, setGuestMode] = useAtom(guestModeAtom)

  const loadProfile = useCallback(async (userId: string) => {
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .maybeSingle()

    if (error) {
      console.warn("Unable to load Supabase profile", error)
      return null
    }

    return data
  }, [])

  const loadAdminRole = useCallback(async (userId: string) => {
    const { data, error } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "admin")
      .maybeSingle()

    if (error) {
      console.warn("Unable to load Supabase user role", error)
      return false
    }

    return data?.role === "admin"
  }, [])

  const syncSession = useCallback(
    async (nextSession: Session | null) => {
      setSession(nextSession)

      const nextUser = nextSession?.user ?? null
      setUser(nextUser)

      if (!nextUser) {
        setProfile(null)
        setIsActualAdmin(false)
        setIsLoading(false)
        return
      }

      setIsLoading(true)

      try {
        const [nextProfile, nextIsAdmin] = await Promise.all([
          loadProfile(nextUser.id),
          loadAdminRole(nextUser.id),
        ])

        setProfile(nextProfile)
        setIsActualAdmin(nextIsAdmin)
      } finally {
        setIsLoading(false)
      }
    },
    [loadAdminRole, loadProfile]
  )

  useEffect(() => {
    let active = true

    const initializeSession = async () => {
      const { data, error } = await supabase.auth.getSession()

      if (error) {
        console.warn("Unable to initialize Supabase session", error)
      }

      if (active) {
        await syncSession(data.session)
      }
    }

    void initializeSession()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      void syncSession(nextSession)
    })

    return () => {
      active = false
      subscription.unsubscribe()
    }
  }, [syncSession])

  const refreshProfile = useCallback(async () => {
    if (!user) {
      setProfile(null)
      setIsActualAdmin(false)
      return
    }

    const [nextProfile, nextIsAdmin] = await Promise.all([
      loadProfile(user.id),
      loadAdminRole(user.id),
    ])

    setProfile(nextProfile)
    setIsActualAdmin(nextIsAdmin)
  }, [loadAdminRole, loadProfile, user])

  const signUp = useCallback(
    async (email: string, password: string, displayName?: string) => {
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: authUrl(),
          data: {
            display_name: displayName?.trim() || email.split("@")[0],
          },
        },
      })

      if (error) throw error
    },
    []
  )

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (error) throw error
  }, [])

  const signInWithEmailOtp = useCallback(
    async (email: string, redirectTo?: string) => {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: redirectTo ?? authUrl(),
          shouldCreateUser: true,
        },
      })

      if (error) throw error
    },
    []
  )

  const signInWithGoogle = useCallback(async (redirectTo?: string) => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: redirectTo ?? authUrl(),
      },
    })

    if (error) throw error
  }, [])

  const signInWithGoogleIdToken = useCallback(
    async (credential: string, nonce: string) => {
      const { data, error } = await supabase.auth.signInWithIdToken({
        provider: "google",
        token: credential,
        nonce,
      })

      if (error) throw error

      await syncSession(data.session)
    },
    [syncSession]
  )

  const getGoogleSignInUrl = useCallback(async (redirectTo?: string) => {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: redirectTo ?? authUrl(),
        skipBrowserRedirect: true,
      },
    })

    if (error) throw error
    if (!data.url) throw new Error("未能创建 Google 登录链接。")

    return data.url
  }, [])

  const completeOAuthFromUrl = useCallback(
    async (url: string) => {
      const target = new URL(url.trim())
      const code = target.searchParams.get("code")

      if (code) {
        const { data, error } = await supabase.auth.exchangeCodeForSession(code)
        if (error) throw error

        await syncSession(data.session)
        return
      }

      const hash = new URLSearchParams(target.hash.replace(/^#/, ""))
      const accessToken = hash.get("access_token")
      const refreshToken = hash.get("refresh_token")

      if (accessToken && refreshToken) {
        const { data, error } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        })
        if (error) throw error

        await syncSession(data.session)
        return
      }

      throw new Error("登录回调链接中没有可用的授权信息。")
    },
    [syncSession]
  )

  const completeTokenSession = useCallback(
    async (accessToken: string, refreshToken: string) => {
      const { data, error } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      })

      if (error) throw error

      await syncSession(data.session)
    },
    [syncSession]
  )

  const signOut = useCallback(async () => {
    const { error } = await supabase.auth.signOut()

    if (error) throw error

    setGuestMode(false)
  }, [setGuestMode])

  const resetPassword = useCallback(async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: authUrl("mode=update-password"),
    })

    if (error) throw error
  }, [])

  const updatePassword = useCallback(async (password: string) => {
    const { error } = await supabase.auth.updateUser({ password })

    if (error) throw error
  }, [])

  const resendVerificationEmail = useCallback(async (email: string) => {
    const { error } = await supabase.auth.resend({
      type: "signup",
      email,
      options: {
        emailRedirectTo: authUrl("verified=true"),
      },
    })

    if (error) throw error
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      session,
      profile,
      isLoading,
      isAdmin: isActualAdmin || guestMode,
      isActualAdmin,
      guestMode,
      setGuestMode,
      refreshProfile,
      signUp,
      signIn,
      signInWithEmailOtp,
      signInWithGoogle,
      signInWithGoogleIdToken,
      getGoogleSignInUrl,
      completeOAuthFromUrl,
      completeTokenSession,
      signOut,
      resetPassword,
      updatePassword,
      resendVerificationEmail,
    }),
    [
      guestMode,
      isActualAdmin,
      isLoading,
      profile,
      refreshProfile,
      resendVerificationEmail,
      resetPassword,
      session,
      setGuestMode,
      signIn,
      signInWithEmailOtp,
      signInWithGoogle,
      signInWithGoogleIdToken,
      getGoogleSignInUrl,
      completeOAuthFromUrl,
      completeTokenSession,
      signOut,
      signUp,
      updatePassword,
      user,
    ]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)

  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider")
  }

  return context
}

function authUrl(query?: string) {
  const origin = window.location.origin
  const suffix = query ? `?${query}` : ""

  return `${origin}/auth${suffix}`
}
