
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "public": {
          Tables: {
            "analysis_locations": {
                  Row: {
                    "address": string | null,"created_at": string,"id": string,"metadata": NonNullable<Json>,"name": string,"project_id": string,"spatial_point": unknown,"updated_at": string,"workspace_id": string
                  }
                  Insert: {
                    "address"?: string | null,"created_at"?: string,"id"?: string,"metadata"?: NonNullable<Json>,"name": string,"project_id": string,"spatial_point": unknown,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "address"?: string | null,"created_at"?: string,"id"?: string,"metadata"?: NonNullable<Json>,"name"?: string,"project_id"?: string,"spatial_point"?: unknown,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "analysis_locations_project_workspace_fk"
      columns: ["project_id","workspace_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["id","workspace_id"]
    }
                  ]
                },"branches": {
                  Row: {
                    "address": string | null,"created_at": string,"customers_count": number | null,"dataset_id": string,"external_id": string | null,"id": string,"import_job_id": string | null,"metadata": NonNullable<Json>,"name": string,"revenue": number | null,"source_row_number": number | null,"spatial_point": unknown,"updated_at": string,"workspace_id": string
                  }
                  Insert: {
                    "address"?: string | null,"created_at"?: string,"customers_count"?: number | null,"dataset_id": string,"external_id"?: string | null,"id"?: string,"import_job_id"?: string | null,"metadata"?: NonNullable<Json>,"name": string,"revenue"?: number | null,"source_row_number"?: number | null,"spatial_point": unknown,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "address"?: string | null,"created_at"?: string,"customers_count"?: number | null,"dataset_id"?: string,"external_id"?: string | null,"id"?: string,"import_job_id"?: string | null,"metadata"?: NonNullable<Json>,"name"?: string,"revenue"?: number | null,"source_row_number"?: number | null,"spatial_point"?: unknown,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "branches_dataset_workspace_fk"
      columns: ["dataset_id","workspace_id"]
isOneToOne: false
      referencedRelation: "datasets"
      referencedColumns: ["id","workspace_id"]
    },{
      foreignKeyName: "branches_import_job_workspace_fk"
      columns: ["import_job_id","workspace_id"]
isOneToOne: false
      referencedRelation: "import_jobs"
      referencedColumns: ["id","workspace_id"]
    }
                  ]
                },"competitors": {
                  Row: {
                    "address": string | null,"brand": string | null,"category": string,"created_at": string,"dataset_id": string,"external_id": string | null,"id": string,"import_job_id": string | null,"metadata": NonNullable<Json>,"name": string,"source": string | null,"source_row_number": number | null,"spatial_point": unknown,"subcategory": string | null,"updated_at": string,"workspace_id": string
                  }
                  Insert: {
                    "address"?: string | null,"brand"?: string | null,"category": string,"created_at"?: string,"dataset_id": string,"external_id"?: string | null,"id"?: string,"import_job_id"?: string | null,"metadata"?: NonNullable<Json>,"name": string,"source"?: string | null,"source_row_number"?: number | null,"spatial_point": unknown,"subcategory"?: string | null,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "address"?: string | null,"brand"?: string | null,"category"?: string,"created_at"?: string,"dataset_id"?: string,"external_id"?: string | null,"id"?: string,"import_job_id"?: string | null,"metadata"?: NonNullable<Json>,"name"?: string,"source"?: string | null,"source_row_number"?: number | null,"spatial_point"?: unknown,"subcategory"?: string | null,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "competitors_dataset_workspace_fk"
      columns: ["dataset_id","workspace_id"]
isOneToOne: false
      referencedRelation: "datasets"
      referencedColumns: ["id","workspace_id"]
    },{
      foreignKeyName: "competitors_import_job_workspace_fk"
      columns: ["import_job_id","workspace_id"]
isOneToOne: false
      referencedRelation: "import_jobs"
      referencedColumns: ["id","workspace_id"]
    }
                  ]
                },"customers": {
                  Row: {
                    "address": string | null,"company": string | null,"created_at": string,"dataset_id": string,"external_id": string | null,"id": string,"import_job_id": string | null,"last_order_date": string | null,"metadata": NonNullable<Json>,"name": string | null,"order_count": number | null,"phone": string | null,"revenue": number | null,"segment": string | null,"source": string | null,"source_row_number": number | null,"spatial_point": unknown,"updated_at": string,"workspace_id": string
                  }
                  Insert: {
                    "address"?: string | null,"company"?: string | null,"created_at"?: string,"dataset_id": string,"external_id"?: string | null,"id"?: string,"import_job_id"?: string | null,"last_order_date"?: string | null,"metadata"?: NonNullable<Json>,"name"?: string | null,"order_count"?: number | null,"phone"?: string | null,"revenue"?: number | null,"segment"?: string | null,"source"?: string | null,"source_row_number"?: number | null,"spatial_point": unknown,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "address"?: string | null,"company"?: string | null,"created_at"?: string,"dataset_id"?: string,"external_id"?: string | null,"id"?: string,"import_job_id"?: string | null,"last_order_date"?: string | null,"metadata"?: NonNullable<Json>,"name"?: string | null,"order_count"?: number | null,"phone"?: string | null,"revenue"?: number | null,"segment"?: string | null,"source"?: string | null,"source_row_number"?: number | null,"spatial_point"?: unknown,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "customers_dataset_workspace_fk"
      columns: ["dataset_id","workspace_id"]
isOneToOne: false
      referencedRelation: "datasets"
      referencedColumns: ["id","workspace_id"]
    },{
      foreignKeyName: "customers_import_job_workspace_fk"
      columns: ["import_job_id","workspace_id"]
isOneToOne: false
      referencedRelation: "import_jobs"
      referencedColumns: ["id","workspace_id"]
    }
                  ]
                },"datasets": {
                  Row: {
                    "created_at": string,"dataset_type": string,"description": string | null,"id": string,"metadata": NonNullable<Json>,"name": string,"source": string | null,"updated_at": string,"workspace_id": string
                  }
                  Insert: {
                    "created_at"?: string,"dataset_type": string,"description"?: string | null,"id"?: string,"metadata"?: NonNullable<Json>,"name": string,"source"?: string | null,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "created_at"?: string,"dataset_type"?: string,"description"?: string | null,"id"?: string,"metadata"?: NonNullable<Json>,"name"?: string,"source"?: string | null,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "datasets_workspace_fk"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"import_jobs": {
                  Row: {
                    "column_mapping": NonNullable<Json>,"committed_at": string | null,"committed_rows": number,"created_at": string,"created_by": string,"dataset_id": string | null,"failed_geocoding_rows": number,"file_type": Database["public"]['Enums']["import_file_type"] | null,"geocoded_rows": number,"id": string,"invalid_rows": number,"metadata": NonNullable<Json>,"needs_geocoding_rows": number,"original_filename": string,"sheet_name": string | null,"status": Database["public"]['Enums']["import_job_status"],"storage_path": string | null,"target_entity": Database["public"]['Enums']["import_target_entity"] | null,"total_rows": number,"updated_at": string,"valid_rows": number,"workspace_id": string
                  }
                  Insert: {
                    "column_mapping"?: NonNullable<Json>,"committed_at"?: string | null,"committed_rows"?: number,"created_at"?: string,"created_by": string,"dataset_id"?: string | null,"failed_geocoding_rows"?: number,"file_type"?: Database["public"]['Enums']["import_file_type"] | null,"geocoded_rows"?: number,"id"?: string,"invalid_rows"?: number,"metadata"?: NonNullable<Json>,"needs_geocoding_rows"?: number,"original_filename": string,"sheet_name"?: string | null,"status"?: Database["public"]['Enums']["import_job_status"],"storage_path"?: string | null,"target_entity"?: Database["public"]['Enums']["import_target_entity"] | null,"total_rows"?: number,"updated_at"?: string,"valid_rows"?: number,"workspace_id": string
                  }
                  Update: {
                    "column_mapping"?: NonNullable<Json>,"committed_at"?: string | null,"committed_rows"?: number,"created_at"?: string,"created_by"?: string,"dataset_id"?: string | null,"failed_geocoding_rows"?: number,"file_type"?: Database["public"]['Enums']["import_file_type"] | null,"geocoded_rows"?: number,"id"?: string,"invalid_rows"?: number,"metadata"?: NonNullable<Json>,"needs_geocoding_rows"?: number,"original_filename"?: string,"sheet_name"?: string | null,"status"?: Database["public"]['Enums']["import_job_status"],"storage_path"?: string | null,"target_entity"?: Database["public"]['Enums']["import_target_entity"] | null,"total_rows"?: number,"updated_at"?: string,"valid_rows"?: number,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "import_jobs_dataset_workspace_fk"
      columns: ["dataset_id","workspace_id"]
isOneToOne: false
      referencedRelation: "datasets"
      referencedColumns: ["id","workspace_id"]
    },{
      foreignKeyName: "import_jobs_workspace_fk"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"import_rows": {
                  Row: {
                    "committed_at": string | null,"committed_record_id": string | null,"created_at": string,"geocoding_attempts": number,"geocoding_claimed_at": string | null,"geocoding_result": Json | null,"geocoding_status": Database["public"]['Enums']["import_row_geocoding_status"],"id": string,"import_job_id": string,"latitude": number | null,"longitude": number | null,"manual_override": boolean,"normalized_data": NonNullable<Json>,"raw_data": NonNullable<Json>,"row_number": number,"updated_at": string,"validation_errors": NonNullable<Json>,"validation_status": Database["public"]['Enums']["import_row_validation_status"],"workspace_id": string
                  }
                  Insert: {
                    "committed_at"?: string | null,"committed_record_id"?: string | null,"created_at"?: string,"geocoding_attempts"?: number,"geocoding_claimed_at"?: string | null,"geocoding_result"?: Json | null,"geocoding_status"?: Database["public"]['Enums']["import_row_geocoding_status"],"id"?: string,"import_job_id": string,"latitude"?: number | null,"longitude"?: number | null,"manual_override"?: boolean,"normalized_data"?: NonNullable<Json>,"raw_data"?: NonNullable<Json>,"row_number": number,"updated_at"?: string,"validation_errors"?: NonNullable<Json>,"validation_status"?: Database["public"]['Enums']["import_row_validation_status"],"workspace_id": string
                  }
                  Update: {
                    "committed_at"?: string | null,"committed_record_id"?: string | null,"created_at"?: string,"geocoding_attempts"?: number,"geocoding_claimed_at"?: string | null,"geocoding_result"?: Json | null,"geocoding_status"?: Database["public"]['Enums']["import_row_geocoding_status"],"id"?: string,"import_job_id"?: string,"latitude"?: number | null,"longitude"?: number | null,"manual_override"?: boolean,"normalized_data"?: NonNullable<Json>,"raw_data"?: NonNullable<Json>,"row_number"?: number,"updated_at"?: string,"validation_errors"?: NonNullable<Json>,"validation_status"?: Database["public"]['Enums']["import_row_validation_status"],"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "import_rows_job_workspace_fk"
      columns: ["import_job_id","workspace_id"]
isOneToOne: false
      referencedRelation: "import_jobs"
      referencedColumns: ["id","workspace_id"]
    }
                  ]
                },"locations": {
                  Row: {
                    "address": string | null,"category": string,"created_at": string,"dataset_id": string,"external_id": string | null,"id": string,"import_job_id": string | null,"metadata": NonNullable<Json>,"name": string,"source": string | null,"source_row_number": number | null,"spatial_point": unknown,"subcategory": string | null,"updated_at": string,"workspace_id": string
                  }
                  Insert: {
                    "address"?: string | null,"category": string,"created_at"?: string,"dataset_id": string,"external_id"?: string | null,"id"?: string,"import_job_id"?: string | null,"metadata"?: NonNullable<Json>,"name": string,"source"?: string | null,"source_row_number"?: number | null,"spatial_point": unknown,"subcategory"?: string | null,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "address"?: string | null,"category"?: string,"created_at"?: string,"dataset_id"?: string,"external_id"?: string | null,"id"?: string,"import_job_id"?: string | null,"metadata"?: NonNullable<Json>,"name"?: string,"source"?: string | null,"source_row_number"?: number | null,"spatial_point"?: unknown,"subcategory"?: string | null,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "locations_dataset_workspace_fk"
      columns: ["dataset_id","workspace_id"]
isOneToOne: false
      referencedRelation: "datasets"
      referencedColumns: ["id","workspace_id"]
    },{
      foreignKeyName: "locations_import_job_workspace_fk"
      columns: ["import_job_id","workspace_id"]
isOneToOne: false
      referencedRelation: "import_jobs"
      referencedColumns: ["id","workspace_id"]
    }
                  ]
                },"organizations": {
                  Row: {
                    "created_at": string,"id": string,"metadata": NonNullable<Json>,"name": string,"slug": string,"updated_at": string
                  }
                  Insert: {
                    "created_at"?: string,"id"?: string,"metadata"?: NonNullable<Json>,"name": string,"slug": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"metadata"?: NonNullable<Json>,"name"?: string,"slug"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"project_datasets": {
                  Row: {
                    "created_at": string,"dataset_id": string,"project_id": string,"workspace_id": string
                  }
                  Insert: {
                    "created_at"?: string,"dataset_id": string,"project_id": string,"workspace_id": string
                  }
                  Update: {
                    "created_at"?: string,"dataset_id"?: string,"project_id"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "project_datasets_dataset_workspace_fk"
      columns: ["dataset_id","workspace_id"]
isOneToOne: false
      referencedRelation: "datasets"
      referencedColumns: ["id","workspace_id"]
    },{
      foreignKeyName: "project_datasets_project_workspace_fk"
      columns: ["project_id","workspace_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["id","workspace_id"]
    },{
      foreignKeyName: "project_datasets_workspace_fk"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"projects": {
                  Row: {
                    "created_at": string,"description": string | null,"id": string,"metadata": NonNullable<Json>,"name": string,"status": string,"updated_at": string,"workspace_id": string
                  }
                  Insert: {
                    "created_at"?: string,"description"?: string | null,"id"?: string,"metadata"?: NonNullable<Json>,"name": string,"status"?: string,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "created_at"?: string,"description"?: string | null,"id"?: string,"metadata"?: NonNullable<Json>,"name"?: string,"status"?: string,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "projects_workspace_fk"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"workspace_members": {
                  Row: {
                    "created_at": string,"id": string,"role": Database["public"]['Enums']["workspace_member_role"],"updated_at": string,"user_id": string,"workspace_id": string
                  }
                  Insert: {
                    "created_at"?: string,"id"?: string,"role": Database["public"]['Enums']["workspace_member_role"],"updated_at"?: string,"user_id": string,"workspace_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"role"?: Database["public"]['Enums']["workspace_member_role"],"updated_at"?: string,"user_id"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "workspace_members_workspace_fk"
      columns: ["workspace_id"]
isOneToOne: false
      referencedRelation: "workspaces"
      referencedColumns: ["id"]
    }
                  ]
                },"workspaces": {
                  Row: {
                    "created_at": string,"id": string,"metadata": NonNullable<Json>,"name": string,"organization_id": string,"slug": string,"updated_at": string
                  }
                  Insert: {
                    "created_at"?: string,"id"?: string,"metadata"?: NonNullable<Json>,"name": string,"organization_id": string,"slug": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"metadata"?: NonNullable<Json>,"name"?: string,"organization_id"?: string,"slug"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "workspaces_organization_fk"
      columns: ["organization_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "apply_import_geocoding_results":
{ Args: { "p_import_job_id": string,"p_results": Json }; Returns: Json
                           },
"bootstrap_workspace_owner":
{ Args: { "p_organization_name": string,"p_organization_slug": string,"p_owner_user_id": string,"p_workspace_name": string,"p_workspace_slug": string }; Returns: {
              "created_workspace": boolean,"membership_id": string,"organization_id": string,"workspace_id": string
            }[]
                           },
"claim_import_geocoding_rows":
{ Args: { "p_import_job_id": string,"p_limit"?: number,"p_max_attempts"?: number,"p_stale_after"?: string }; Returns: {
              "address": string,"attempts": number,"row_id": string,"row_number": number
            }[]
                           },
"commit_import_job":
{ Args: { "p_dataset_id"?: string,"p_import_job_id": string,"p_new_dataset_name"?: string,"p_new_dataset_type"?: string }; Returns: {
              "conflicting_rows": number,"dataset_created": boolean,"inserted_rows": number,"job_id": string,"job_status": Database["public"]['Enums']["import_job_status"],"previously_committed_rows": number,"target_dataset_id": string
            }[]
                           },
"demo_radius_analysis":
{ Args: { "p_latitude": number,"p_longitude": number,"p_radius_meters": number }; Returns: {
              "branches_count": number,"category_distribution": Json,"competitors_count": number,"customers_count": number,"customers_revenue_total": string,"locations_count": number,"nearest_branch_distance_meters": number,"nearest_branch_id": string,"nearest_branch_name": string
            }[]
                           },
"demo_viewport_features":
{ Args: { "p_east": number,"p_kinds"?: (string)[],"p_limit"?: number,"p_north": number,"p_south": number,"p_west": number }; Returns: {
              "category": string,"display_name": string,"feature_id": string,"kind": string,"latitude": number,"longitude": number
            }[]
                           },
"grant_workspace_owner":
{ Args: { "p_user_id": string,"p_workspace_id": string }; Returns: string
                           },
"has_workspace_role":
{ Args: { "p_allowed_roles": (Database["public"]['Enums']["workspace_member_role"])[],"p_workspace_id": string }; Returns: boolean
                           },
"import_object_workspace_id":
{ Args: { "p_object_name": string }; Returns: string
                           },
"is_workspace_member":
{ Args: { "p_workspace_id": string }; Returns: boolean
                           },
"refresh_import_job_counters":
{ Args: { "p_import_job_id": string }; Returns: {
              "committed_rows": number,"failed_geocoding_rows": number,"geocoded_rows": number,"invalid_rows": number,"job_status": Database["public"]['Enums']["import_job_status"],"needs_geocoding_rows": number,"total_rows": number,"valid_rows": number
            }[]
                           },
"set_import_row_manual_point":
{ Args: { "p_import_row_id": string,"p_latitude": number,"p_longitude": number }; Returns: Database["public"]['Enums']["import_row_validation_status"]
                           },
"update_import_job_metadata":
{ Args: { "p_import_job_id": string,"p_patch": Json }; Returns: Json
                           },
"workspace_radius_analysis":
{ Args: { "p_latitude": number,"p_longitude": number,"p_radius_meters": number,"p_workspace_id": string }; Returns: {
              "branches_count": number,"category_distribution": Json,"competitors_count": number,"customers_count": number,"customers_revenue_total": string,"locations_count": number,"nearest_branch_distance_meters": number,"nearest_branch_id": string,"nearest_branch_name": string
            }[]
                           },
"workspace_role":
{ Args: { "p_workspace_id": string }; Returns: Database["public"]['Enums']["workspace_member_role"]
                           },
"workspace_viewport_features":
{ Args: { "p_east": number,"p_kinds"?: (string)[],"p_limit"?: number,"p_north": number,"p_south": number,"p_west": number,"p_workspace_id": string }; Returns: {
              "category": string,"display_name": string,"feature_id": string,"kind": string,"latitude": number,"longitude": number
            }[]
                           }
          }
          Enums: {
            "import_file_type": "csv"|"xlsx","import_job_status": "uploaded"|"mapping_required"|"ready"|"review_required"|"completed"|"failed","import_row_geocoding_status": "not_required"|"pending"|"geocoding"|"success"|"ambiguous"|"no_match"|"provider_error"|"rate_limited"|"manual_override","import_row_validation_status": "pending"|"valid"|"needs_geocoding"|"invalid","import_target_entity": "customers"|"locations","workspace_member_role": "owner"|"admin"|"analyst"|"viewer"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "public": {
          Enums: {
            "import_file_type": ["csv", "xlsx"],"import_job_status": ["uploaded", "mapping_required", "ready", "review_required", "completed", "failed"],"import_row_geocoding_status": ["not_required", "pending", "geocoding", "success", "ambiguous", "no_match", "provider_error", "rate_limited", "manual_override"],"import_row_validation_status": ["pending", "valid", "needs_geocoding", "invalid"],"import_target_entity": ["customers", "locations"],"workspace_member_role": ["owner", "admin", "analyst", "viewer"]
          }
        }
} as const
