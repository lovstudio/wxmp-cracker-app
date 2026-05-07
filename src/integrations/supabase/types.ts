export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string | null
          email: string | null
          id: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          email?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          email?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      wxmp_licenses: {
        Row: {
          account_id: string
          created_at: string
          created_by: string | null
          customer: string | null
          expires_at: string
          id: string
          kind: Database["public"]["Enums"]["license_kind"]
          quota_level: number
          status: Database["public"]["Enums"]["license_status"]
          updated_at: string
        }
        Insert: {
          account_id: string
          created_at?: string
          created_by?: string | null
          customer?: string | null
          expires_at: string
          id?: string
          kind: Database["public"]["Enums"]["license_kind"]
          quota_level?: number
          status?: Database["public"]["Enums"]["license_status"]
          updated_at?: string
        }
        Update: {
          account_id?: string
          created_at?: string
          created_by?: string | null
          customer?: string | null
          expires_at?: string
          id?: string
          kind?: Database["public"]["Enums"]["license_kind"]
          quota_level?: number
          status?: Database["public"]["Enums"]["license_status"]
          updated_at?: string
        }
        Relationships: []
      }
      wxmp_quota_settings: {
        Row: {
          account_level_factor: number
          created_at: string
          default_account_level: number
          id: string
          own_capability_factor: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          account_level_factor?: number
          created_at?: string
          default_account_level?: number
          id?: string
          own_capability_factor?: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          account_level_factor?: number
          created_at?: string
          default_account_level?: number
          id?: string
          own_capability_factor?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      wxmp_user_capabilities: {
        Row: {
          capability_units: number
          commercial_terms_accepted_at: string | null
          created_at: string
          mp_alias: string | null
          mp_nickname: string | null
          mp_username: string | null
          provides_to_others: boolean
          service_type: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          capability_units?: number
          commercial_terms_accepted_at?: string | null
          created_at?: string
          mp_alias?: string | null
          mp_nickname?: string | null
          mp_username?: string | null
          provides_to_others?: boolean
          service_type?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          capability_units?: number
          commercial_terms_accepted_at?: string | null
          created_at?: string
          mp_alias?: string | null
          mp_nickname?: string | null
          mp_username?: string | null
          provides_to_others?: boolean
          service_type?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      get_wxmp_license: {
        Args: {
          _account_id: string
        }
        Returns: {
          account_id: string
          customer: string | null
          expires_at: string
          expires_at_epoch: number
          id: string
          kind: Database["public"]["Enums"]["license_kind"]
          quota_level: number
          status: Database["public"]["Enums"]["license_status"]
          updated_at: string
        }[]
      }
      get_wxmp_quota_entitlement: {
        Args: {
          _account_id: string
        }
        Returns: {
          account_id: string
          account_level: number
          account_level_factor: number
          commercial_terms_accepted_at: string | null
          hourly_quota: number
          own_capability_factor: number
          own_capability_units: number
          provides_to_others: boolean
        }[]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin" | "user"
      license_kind: "trial" | "official"
      license_status: "active" | "revoked"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DefaultSchema = Omit<Database, "__InternalSupabase">[Extract<
  keyof Database,
  "public"
>]

export type Tables<
  T extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"]),
> = (DefaultSchema["Tables"] & DefaultSchema["Views"])[T] extends {
  Row: infer R
}
  ? R
  : never

export type TablesInsert<T extends keyof DefaultSchema["Tables"]> =
  DefaultSchema["Tables"][T] extends { Insert: infer I } ? I : never

export type TablesUpdate<T extends keyof DefaultSchema["Tables"]> =
  DefaultSchema["Tables"][T] extends { Update: infer U } ? U : never

export type Enums<T extends keyof DefaultSchema["Enums"]> =
  DefaultSchema["Enums"][T]
