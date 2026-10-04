
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
                    "address": string | null,"created_at": string,"customers_count": number | null,"dataset_id": string,"external_id": string | null,"id": string,"metadata": NonNullable<Json>,"name": string,"revenue": number | null,"spatial_point": unknown,"updated_at": string,"workspace_id": string
                  }
                  Insert: {
                    "address"?: string | null,"created_at"?: string,"customers_count"?: number | null,"dataset_id": string,"external_id"?: string | null,"id"?: string,"metadata"?: NonNullable<Json>,"name": string,"revenue"?: number | null,"spatial_point": unknown,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "address"?: string | null,"created_at"?: string,"customers_count"?: number | null,"dataset_id"?: string,"external_id"?: string | null,"id"?: string,"metadata"?: NonNullable<Json>,"name"?: string,"revenue"?: number | null,"spatial_point"?: unknown,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "branches_dataset_workspace_fk"
      columns: ["dataset_id","workspace_id"]
isOneToOne: false
      referencedRelation: "datasets"
      referencedColumns: ["id","workspace_id"]
    }
                  ]
                },"competitors": {
                  Row: {
                    "address": string | null,"brand": string | null,"category": string,"created_at": string,"dataset_id": string,"external_id": string | null,"id": string,"metadata": NonNullable<Json>,"name": string,"source": string | null,"spatial_point": unknown,"subcategory": string | null,"updated_at": string,"workspace_id": string
                  }
                  Insert: {
                    "address"?: string | null,"brand"?: string | null,"category": string,"created_at"?: string,"dataset_id": string,"external_id"?: string | null,"id"?: string,"metadata"?: NonNullable<Json>,"name": string,"source"?: string | null,"spatial_point": unknown,"subcategory"?: string | null,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "address"?: string | null,"brand"?: string | null,"category"?: string,"created_at"?: string,"dataset_id"?: string,"external_id"?: string | null,"id"?: string,"metadata"?: NonNullable<Json>,"name"?: string,"source"?: string | null,"spatial_point"?: unknown,"subcategory"?: string | null,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "competitors_dataset_workspace_fk"
      columns: ["dataset_id","workspace_id"]
isOneToOne: false
      referencedRelation: "datasets"
      referencedColumns: ["id","workspace_id"]
    }
                  ]
                },"customers": {
                  Row: {
                    "address": string | null,"company": string | null,"created_at": string,"dataset_id": string,"external_id": string | null,"id": string,"last_order_date": string | null,"metadata": NonNullable<Json>,"name": string | null,"order_count": number | null,"phone": string | null,"revenue": number | null,"segment": string | null,"source": string | null,"spatial_point": unknown,"updated_at": string,"workspace_id": string
                  }
                  Insert: {
                    "address"?: string | null,"company"?: string | null,"created_at"?: string,"dataset_id": string,"external_id"?: string | null,"id"?: string,"last_order_date"?: string | null,"metadata"?: NonNullable<Json>,"name"?: string | null,"order_count"?: number | null,"phone"?: string | null,"revenue"?: number | null,"segment"?: string | null,"source"?: string | null,"spatial_point": unknown,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "address"?: string | null,"company"?: string | null,"created_at"?: string,"dataset_id"?: string,"external_id"?: string | null,"id"?: string,"last_order_date"?: string | null,"metadata"?: NonNullable<Json>,"name"?: string | null,"order_count"?: number | null,"phone"?: string | null,"revenue"?: number | null,"segment"?: string | null,"source"?: string | null,"spatial_point"?: unknown,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "customers_dataset_workspace_fk"
      columns: ["dataset_id","workspace_id"]
isOneToOne: false
      referencedRelation: "datasets"
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
                },"locations": {
                  Row: {
                    "address": string | null,"category": string,"created_at": string,"dataset_id": string,"external_id": string | null,"id": string,"metadata": NonNullable<Json>,"name": string,"source": string | null,"spatial_point": unknown,"subcategory": string | null,"updated_at": string,"workspace_id": string
                  }
                  Insert: {
                    "address"?: string | null,"category": string,"created_at"?: string,"dataset_id": string,"external_id"?: string | null,"id"?: string,"metadata"?: NonNullable<Json>,"name": string,"source"?: string | null,"spatial_point": unknown,"subcategory"?: string | null,"updated_at"?: string,"workspace_id": string
                  }
                  Update: {
                    "address"?: string | null,"category"?: string,"created_at"?: string,"dataset_id"?: string,"external_id"?: string | null,"id"?: string,"metadata"?: NonNullable<Json>,"name"?: string,"source"?: string | null,"spatial_point"?: unknown,"subcategory"?: string | null,"updated_at"?: string,"workspace_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "locations_dataset_workspace_fk"
      columns: ["dataset_id","workspace_id"]
isOneToOne: false
      referencedRelation: "datasets"
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
            "demo_radius_analysis":
{ Args: { "p_latitude": number,"p_longitude": number,"p_radius_meters": number }; Returns: {
              "branches_count": number,"category_distribution": Json,"competitors_count": number,"customers_count": number,"customers_revenue_total": string,"locations_count": number,"nearest_branch_distance_meters": number,"nearest_branch_id": string,"nearest_branch_name": string
            }[]
                           },
"demo_viewport_features":
{ Args: { "p_east": number,"p_kinds"?: (string)[],"p_limit"?: number,"p_north": number,"p_south": number,"p_west": number }; Returns: {
              "category": string,"display_name": string,"feature_id": string,"kind": string,"latitude": number,"longitude": number
            }[]
                           }
          }
          Enums: {
            [_ in never]: never
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
            
          }
        }
} as const
