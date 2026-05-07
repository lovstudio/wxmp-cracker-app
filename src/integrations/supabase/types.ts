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
      wxmp_gateway_alerts: {
        Row: {
          acknowledged_at: string | null
          alert_key: string
          created_at: string
          id: string
          message: string
          opened_at: string
          owner_user_id: string | null
          provider_node_id: string | null
          resolved_at: string | null
          severity: string
          status: string
          updated_at: string
        }
        Insert: {
          acknowledged_at?: string | null
          alert_key: string
          created_at?: string
          id?: string
          message: string
          opened_at?: string
          owner_user_id?: string | null
          provider_node_id?: string | null
          resolved_at?: string | null
          severity?: string
          status?: string
          updated_at?: string
        }
        Update: {
          acknowledged_at?: string | null
          alert_key?: string
          created_at?: string
          id?: string
          message?: string
          opened_at?: string
          owner_user_id?: string | null
          provider_node_id?: string | null
          resolved_at?: string | null
          severity?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      wxmp_gateway_requests: {
        Row: {
          assigned_owner_user_id: string | null
          assigned_provider_node_id: string | null
          attempt_count: number
          created_at: string
          endpoint: string | null
          enqueued_at: string
          error_code: string | null
          error_message: string | null
          finished_at: string | null
          id: string
          idempotency_key: string | null
          latency_ms: number | null
          payload: Json
          priority: number
          quota_cost: number
          request_kind: string
          requester_user_id: string
          result_payload: Json
          started_at: string | null
          status: string
          target_fakeid: string | null
          trace_id: string | null
          updated_at: string
        }
        Insert: {
          assigned_owner_user_id?: string | null
          assigned_provider_node_id?: string | null
          attempt_count?: number
          created_at?: string
          endpoint?: string | null
          enqueued_at?: string
          error_code?: string | null
          error_message?: string | null
          finished_at?: string | null
          id?: string
          idempotency_key?: string | null
          latency_ms?: number | null
          payload?: Json
          priority?: number
          quota_cost?: number
          request_kind: string
          requester_user_id?: string
          result_payload?: Json
          started_at?: string | null
          status?: string
          target_fakeid?: string | null
          trace_id?: string | null
          updated_at?: string
        }
        Update: {
          assigned_owner_user_id?: string | null
          assigned_provider_node_id?: string | null
          attempt_count?: number
          created_at?: string
          endpoint?: string | null
          enqueued_at?: string
          error_code?: string | null
          error_message?: string | null
          finished_at?: string | null
          id?: string
          idempotency_key?: string | null
          latency_ms?: number | null
          payload?: Json
          priority?: number
          quota_cost?: number
          request_kind?: string
          requester_user_id?: string
          result_payload?: Json
          started_at?: string | null
          status?: string
          target_fakeid?: string | null
          trace_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      wxmp_provider_health_events: {
        Row: {
          created_at: string
          event_type: string
          id: string
          message: string | null
          observed_value: Json
          owner_user_id: string | null
          provider_node_id: string | null
          severity: string
          trace_id: string | null
        }
        Insert: {
          created_at?: string
          event_type: string
          id?: string
          message?: string | null
          observed_value?: Json
          owner_user_id?: string | null
          provider_node_id?: string | null
          severity?: string
          trace_id?: string | null
        }
        Update: {
          created_at?: string
          event_type?: string
          id?: string
          message?: string | null
          observed_value?: Json
          owner_user_id?: string | null
          provider_node_id?: string | null
          severity?: string
          trace_id?: string | null
        }
        Relationships: []
      }
      wxmp_provider_leases: {
        Row: {
          consumed_at: string | null
          created_at: string
          expires_at: string
          gateway_request_id: string | null
          id: string
          lease_kind: string
          leased_by: string | null
          provider_node_id: string
          quota_units: number
          status: string
          updated_at: string
        }
        Insert: {
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          gateway_request_id?: string | null
          id?: string
          lease_kind: string
          leased_by?: string | null
          provider_node_id: string
          quota_units?: number
          status?: string
          updated_at?: string
        }
        Update: {
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          gateway_request_id?: string | null
          id?: string
          lease_kind?: string
          leased_by?: string | null
          provider_node_id?: string
          quota_units?: number
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      wxmp_provider_nodes: {
        Row: {
          capability_user_id: string | null
          commercial_capability_units: number
          commercial_enabled: boolean
          commercial_terms_accepted_at: string | null
          cooldown_until: string | null
          created_at: string
          current_hour_capacity: number
          current_hour_started_at: string
          current_hour_used: number
          health_score: number
          id: string
          last_seen_at: string | null
          mp_alias: string | null
          mp_nickname: string | null
          mp_username: string | null
          owner_user_id: string
          self_capability_units: number
          self_use_enabled: boolean
          service_type: string | null
          status: string
          updated_at: string
        }
        Insert: {
          capability_user_id?: string | null
          commercial_capability_units?: number
          commercial_enabled?: boolean
          commercial_terms_accepted_at?: string | null
          cooldown_until?: string | null
          created_at?: string
          current_hour_capacity?: number
          current_hour_started_at?: string
          current_hour_used?: number
          health_score?: number
          id?: string
          last_seen_at?: string | null
          mp_alias?: string | null
          mp_nickname?: string | null
          mp_username?: string | null
          owner_user_id?: string
          self_capability_units?: number
          self_use_enabled?: boolean
          service_type?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          capability_user_id?: string | null
          commercial_capability_units?: number
          commercial_enabled?: boolean
          commercial_terms_accepted_at?: string | null
          cooldown_until?: string | null
          created_at?: string
          current_hour_capacity?: number
          current_hour_started_at?: string
          current_hour_used?: number
          health_score?: number
          id?: string
          last_seen_at?: string | null
          mp_alias?: string | null
          mp_nickname?: string | null
          mp_username?: string | null
          owner_user_id?: string
          self_capability_units?: number
          self_use_enabled?: boolean
          service_type?: string | null
          status?: string
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
      claim_wxmp_gateway_request: {
        Args: {
          _lease_seconds?: number
          _provider_node_id?: string | null
        }
        Returns: {
          assigned_provider_node_id: string | null
          endpoint: string | null
          lease_id: string
          payload: Json
          quota_cost: number
          request_id: string
          request_kind: string
          requester_user_id: string
          target_fakeid: string | null
          trace_id: string | null
        }[]
      }
      complete_wxmp_gateway_request: {
        Args: {
          _error_code?: string | null
          _error_message?: string | null
          _latency_ms?: number | null
          _lease_id: string
          _request_id: string
          _result_payload?: Json
          _status: string
        }
        Returns: {
          provider_health_score: number
          provider_node_id: string
          provider_status: string
          request_id: string
          request_status: string
        }[]
      }
      enqueue_wxmp_gateway_request: {
        Args: {
          _endpoint: string
          _idempotency_key?: string | null
          _payload?: Json
          _priority?: number
          _quota_cost?: number
          _request_kind: string
          _target_fakeid?: string | null
        }
        Returns: {
          endpoint: string | null
          enqueued_at: string
          request_id: string
          request_kind: string
          request_status: string
          target_fakeid: string | null
        }[]
      }
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
      heartbeat_wxmp_provider_node: {
        Args: Record<PropertyKey, never>
        Returns: {
          last_seen_at: string
          provider_health_score: number
          provider_node_id: string
          provider_status: string
          remaining_capacity: number
        }[]
      }
      report_wxmp_provider_execution: {
        Args: {
          _endpoint: string
          _error_code?: string | null
          _error_message?: string | null
          _latency_ms?: number | null
          _observed_value?: Json
          _quota_cost?: number
          _status: string
        }
        Returns: {
          current_hour_used: number
          provider_health_score: number
          provider_node_id: string
          provider_status: string
          remaining_capacity: number
        }[]
      }
      start_wxmp_provider_execution: {
        Args: {
          _endpoint: string
          _payload?: Json
          _priority?: number
          _quota_cost?: number
          _target_fakeid?: string | null
        }
        Returns: {
          lease_id: string
          provider_node_id: string
          request_id: string
          request_status: string
          trace_id: string
        }[]
      }
      get_wxmp_gateway_overview: {
        Args: {
          _account_id: string
        }
        Returns: {
          account_id: string
          commercial_capability_units: number
          commercial_enabled: boolean
          commercial_pool_hourly_capacity: number
          commercial_pool_nodes: number
          effective_hourly_quota: number
          executable_pool_hourly_capacity: number
          last_health_event_at: string | null
          open_alerts: number
          provider_health_score: number
          provider_node_id: string | null
          provider_status: string
          queued_requests: number
          running_requests: number
          self_capability_units: number
          self_hourly_quota: number
          self_remaining_capacity: number
          self_use_enabled: boolean
          theoretical_hourly_quota: number
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
