-- Phase 7, migration 2 of 2: private Supabase Storage bucket for report artifacts.
--
-- Object layout, always derived from the report row itself (see the
-- analysis_reports_storage_path_scope check constraints):
--
--   {workspace_id}/{project_id}/{report_id}/report.pdf
--   {workspace_id}/{project_id}/{report_id}/map.png
--   {workspace_id}/{project_id}/{report_id}/logo.png | logo.jpg
--
-- The path is a convenience, never the authorization: every policy re-derives
-- the workspace from the first path segment, requires the full four-segment
-- shape, and then asks public.has_workspace_role(...) for the caller. A path
-- that does not start with a UUID, or that is not shaped like a report object,
-- grants nothing. Nothing here exposes a public URL, and the bucket is private.

-- ---------------------------------------------------------------------------
-- Private bucket
-- ---------------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'analysis-reports',
  'analysis-reports',
  false,
  10485760, -- 10 MB: one A4 report PDF with a static map and a logo fits easily
  ARRAY[
    'application/pdf',
    'image/png',
    'image/jpeg'
  ]
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- Safe path parsing
-- ---------------------------------------------------------------------------

-- Returns the workspace UUID encoded in the first path segment, or NULL when the
-- object name is not exactly <workspace-uuid>/<project-uuid>/<report-uuid>/<file>.
-- A function (rather than an inline cast in the policy) because a malformed name
-- must yield "no access" instead of raising a cast error.
CREATE OR REPLACE FUNCTION public.report_object_workspace_id(p_object_name text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  segments text[];
  uuid_pattern constant text :=
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
BEGIN
  IF p_object_name IS NULL OR p_object_name = '' THEN
    RETURN NULL;
  END IF;

  -- storage.foldername drops the file segment, so a report artifact
  -- <workspace>/<project>/<report>/<file> yields exactly three parts.
  segments := storage.foldername(p_object_name);
  IF segments IS NULL OR pg_catalog.array_length(segments, 1) < 3 THEN
    RETURN NULL;
  END IF;

  IF segments[1] !~ uuid_pattern
     OR segments[2] !~ uuid_pattern
     OR segments[3] !~ uuid_pattern THEN
    RETURN NULL;
  END IF;

  RETURN segments[1]::uuid;
EXCEPTION
  WHEN others THEN
    RETURN NULL;
END;
$function$;

COMMENT ON FUNCTION public.report_object_workspace_id(text) IS
  'Extracts the workspace UUID from <workspace-uuid>/<project-uuid>/<report-uuid>/<file> report object names, or NULL when the name is not shaped like a report artifact. SECURITY INVOKER, fixed search_path, never raises.';

REVOKE ALL ON FUNCTION public.report_object_workspace_id(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.report_object_workspace_id(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Storage policies
-- ---------------------------------------------------------------------------

-- Every member (viewer included) may read a report artifact of a workspace they
-- belong to: the spec allows a viewer to preview and download a ready report.
-- Generating/uploading artifacts is limited to owner/admin/analyst, matching the
-- role matrix on the table itself, so a viewer cannot even replace a PDF bytes.
-- No policy grants anon anything, and there is no DELETE policy: report
-- artifacts follow the table's audit-trail rule.

CREATE POLICY analysis_reports_storage_select_member
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'analysis-reports'
    AND public.is_workspace_member(public.report_object_workspace_id(name))
  );

CREATE POLICY analysis_reports_storage_insert_run
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'analysis-reports'
    AND public.has_workspace_role(
      public.report_object_workspace_id(name),
      ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]
    )
  );

CREATE POLICY analysis_reports_storage_update_run
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'analysis-reports'
    AND public.has_workspace_role(
      public.report_object_workspace_id(name),
      ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]
    )
  )
  WITH CHECK (
    bucket_id = 'analysis-reports'
    AND public.has_workspace_role(
      public.report_object_workspace_id(name),
      ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]
    )
  );

COMMENT ON POLICY analysis_reports_storage_select_member ON storage.objects IS
  'Workspace members (viewers included) read report artifacts; the workspace is derived from the object path and re-verified against membership.';
COMMENT ON POLICY analysis_reports_storage_insert_run ON storage.objects IS
  'Only owner/admin/analyst may store report artifacts (PDF, map, logo).';
COMMENT ON POLICY analysis_reports_storage_update_run ON storage.objects IS
  'Only owner/admin/analyst may overwrite report artifacts, e.g. when regenerating the PDF of an unchanged snapshot.';
