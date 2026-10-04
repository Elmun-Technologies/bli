-- Phase 1 foundation only: install PostGIS in Supabase's extensions schema.
-- Business tables, indexes, grants, and RLS policies are introduced in Phase 2.
create schema if not exists extensions;

create extension if not exists postgis with schema extensions;

comment on extension postgis is
  'Spatial types and functions for the Location Intelligence Platform';
