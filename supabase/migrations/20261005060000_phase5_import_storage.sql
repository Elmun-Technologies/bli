-- Phase 5, migration 2 of 2: private Supabase Storage bucket for import source
-- files, with membership-checked policies.
--
-- Object layout: {workspace_id}/{import_id}/source.{ext}
--
-- The path is a convenience, never the authorization: every policy re-derives
-- the workspace from the first path segment and then asks
-- public.has_workspace_role(...) for the caller. A path that does not start with
-- a UUID grants nothing, and the original filename is metadata on import_jobs,
-- not part of the object key.

-- ---------------------------------------------------------------------------
-- Private bucket
-- ---------------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'workspace-imports',
  'workspace-imports',
  false,
  5242880, -- 5 MB: the Phase 5 standard-upload limit, enforced by Storage too
  ARRAY[
    'text/csv',
    'application/csv',
    'text/plain',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/octet-stream'
  ]
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- Safe path parsing
-- ---------------------------------------------------------------------------

-- Returns the workspace UUID encoded in the first path segment, or NULL when
-- the object name does not have the expected shape. A function (rather than an
-- inline cast in the policy) because a malformed name must yield "no access"
-- instead of raising a cast error that would abort the request.
CREATE OR REPLACE FUNCTION public.import_object_workspace_id(p_object_name text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  segments text[];
  candidate text;
BEGIN
  IF p_object_name IS NULL OR p_object_name = '' THEN
    RETURN NULL;
  END IF;

  segments := storage.foldername(p_object_name);
  IF segments IS NULL OR pg_catalog.array_length(segments, 1) < 2 THEN
    RETURN NULL;
  END IF;

  candidate := segments[1];
  IF candidate !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    RETURN NULL;
  END IF;

  RETURN candidate::uuid;
EXCEPTION
  WHEN others THEN
    RETURN NULL;
END;
$function$;

COMMENT ON FUNCTION public.import_object_workspace_id(text) IS
  'Extracts the workspace UUID from the first segment of a workspace-imports object name, or NULL when the name is not <workspace-uuid>/<import-uuid>/<file>. SECURITY INVOKER, fixed search_path, never raises.';

REVOKE ALL ON FUNCTION public.import_object_workspace_id(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.import_object_workspace_id(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Storage policies
-- ---------------------------------------------------------------------------

-- Only owner/admin/analyst may see or write import files of a workspace they
-- belong to. A viewer has read access to import metadata (so the import list is
-- visible) but no access to the stored source file, matching "viewer cannot
-- upload and cannot commit".

CREATE POLICY workspace_imports_select_analyst
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'workspace-imports'
    AND public.has_workspace_role(
      public.import_object_workspace_id(name),
      ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]
    )
  );

CREATE POLICY workspace_imports_insert_analyst
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'workspace-imports'
    AND public.has_workspace_role(
      public.import_object_workspace_id(name),
      ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]
    )
  );

CREATE POLICY workspace_imports_update_analyst
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'workspace-imports'
    AND public.has_workspace_role(
      public.import_object_workspace_id(name),
      ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]
    )
  )
  WITH CHECK (
    bucket_id = 'workspace-imports'
    AND public.has_workspace_role(
      public.import_object_workspace_id(name),
      ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]
    )
  );

CREATE POLICY workspace_imports_delete_analyst
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'workspace-imports'
    AND public.has_workspace_role(
      public.import_object_workspace_id(name),
      ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]
    )
  );

-- No policy grants anon anything, and the bucket is private, so a signed-out
-- visitor can neither list nor download an import file.
--
-- Retention: source files are kept for the lifetime of the import job. There is
-- deliberately no lifecycle automation in Phase 5 (the deletion policy above is
-- what an operator or a later retention job would use); see docs/imports.md.
