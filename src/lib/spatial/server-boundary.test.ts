import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const SOURCE_ROOT = path.join(process.cwd(), 'src');
const SERVER_ONLY_MODULES = [
  '@/lib/supabase/admin',
  '@/lib/spatial/service',
  '@/lib/spatial/tenant-service',
  '@/lib/spatial/demo-workspace',
  '@/lib/spatial/fixtures',
  '@/lib/spatial/http',
  '@/lib/auth/session',
  '@/lib/auth/workspace-access',
];
const FORBIDDEN_CLIENT_ENV = [
  'NEXT_PUBLIC_SUPABASE_SECRET_KEY',
  'NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY',
  'NEXT_PUBLIC_SERVICE_ROLE',
];

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const absolutePath = path.join(directory, entry);
    if (statSync(absolutePath).isDirectory()) return listSourceFiles(absolutePath);
    return /\.(?:ts|tsx)$/.test(entry) ? [absolutePath] : [];
  });
}

const sourceFiles = listSourceFiles(SOURCE_ROOT).map((absolutePath) => ({
  relativePath: path.relative(process.cwd(), absolutePath),
  contents: readFileSync(absolutePath, 'utf8'),
}));

// Test files are excluded from literal scans (they contain the patterns under
// test and are never part of a production bundle).
const productionFiles = sourceFiles.filter((file) => !/\.test\.tsx?$/.test(file.relativePath));

test('the elevated credential module is server-only', () => {
  const adminFile = sourceFiles.find((file) => file.relativePath.endsWith('src/lib/supabase/admin.ts'));
  assert.ok(adminFile, 'src/lib/supabase/admin.ts must exist');
  assert.match(adminFile.contents, /^import 'server-only';/m);

  for (const moduleName of SERVER_ONLY_MODULES) {
    const moduleFile = sourceFiles.find((file) =>
      file.relativePath.endsWith(`${moduleName.replace('@/', 'src/').replace(/^src/, 'src')}.ts`),
    );
    if (!moduleFile) continue;
    if (moduleFile.relativePath.endsWith('src/lib/spatial/http.ts')) continue;
    if (moduleFile.relativePath.endsWith('src/lib/spatial/fixtures.ts')) continue;
    assert.match(moduleFile.contents, /^import 'server-only';/m, `${moduleFile.relativePath} must import server-only`);
  }
});

test('no client component imports server-only spatial modules', () => {
  for (const file of sourceFiles) {
    if (!/^'use client';/m.test(file.contents)) continue;

    for (const moduleName of SERVER_ONLY_MODULES) {
      assert.equal(
        file.contents.includes(`from '${moduleName}'`),
        false,
        `${file.relativePath} must not import ${moduleName}`,
      );
    }
  }
});

test('no public environment variable carries an elevated credential', () => {
  for (const file of productionFiles) {
    for (const forbidden of FORBIDDEN_CLIENT_ENV) {
      assert.equal(
        file.contents.includes(forbidden),
        false,
        `${file.relativePath} must not use ${forbidden}`,
      );
    }
  }
});

test('the tenant GIS path never imports the elevated client', () => {
  const tenantModules = [
    'src/lib/spatial/tenant-service.ts',
    'src/lib/auth/workspace-access.ts',
    'src/lib/auth/session.ts',
    'src/app/api/workspaces/[workspaceId]/map/features/route.ts',
    'src/app/api/workspaces/[workspaceId]/analysis/radius/route.ts',
  ];

  for (const relativePath of tenantModules) {
    const file = productionFiles.find((candidate) => candidate.relativePath === relativePath);
    assert.ok(file, `${relativePath} must exist`);
    assert.equal(
      file.contents.includes("from '@/lib/supabase/admin'"),
      false,
      `${relativePath} must not import the elevated service-role client`,
    );
    assert.equal(
      file.contents.includes('SUPABASE_SECRET_KEY') || file.contents.includes('SERVICE_ROLE_KEY'),
      false,
      `${relativePath} must not read an elevated credential`,
    );
  }
});

test('the tenant RPCs are called through the cookie-aware session client', () => {
  const tenantService = productionFiles.find((file) =>
    file.relativePath.endsWith('src/lib/spatial/tenant-service.ts'),
  );
  assert.ok(tenantService, 'src/lib/spatial/tenant-service.ts must exist');
  assert.match(tenantService.contents, /from '@\/lib\/supabase\/server'/);
  assert.match(tenantService.contents, /workspace_viewport_features/);
  assert.match(tenantService.contents, /workspace_radius_analysis/);
  // Authentication is decided by the auth server, never by a cookie payload.
  assert.match(tenantService.contents, /auth\.getUser\(\)/);
});

test('the elevated client is never constructed in a browser-reachable module', () => {
  const importers = productionFiles
    .filter((file) => file.contents.includes("from '@/lib/supabase/admin'"))
    .map((file) => file.relativePath)
    .sort();

  assert.deepEqual(importers, [
    'src/lib/spatial/demo-workspace.ts',
    'src/lib/spatial/service.ts',
  ]);
});
