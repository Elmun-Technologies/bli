'use client';

import { ArrowLeft, Layers3, MapPinned } from 'lucide-react';

import type { WorkspaceSection } from '@/components/app/left-sidebar';

const SECTION_DETAILS: Record<WorkspaceSection, { phase: string; description: string }> = {
  Dashboard: {
    phase: 'After the data foundations',
    description: 'Decision-ready KPIs and market summaries will be connected to workspace datasets.',
  },
  Map: {
    phase: 'Phase 1 · available now',
    description: 'Explore the interactive Tashkent pilot map and its sample layers.',
  },
  Import: {
    phase: 'Phase 5',
    description: 'Upload CSV and XLSX files, map their columns, validate every row and geocode addresses here.',
  },
  Customers: {
    phase: 'Phase 5',
    description: 'Customer uploads, validation, privacy controls, clustering and heatmaps are planned here.',
  },
  Locations: {
    phase: 'Phase 6 · database workspace',
    description:
      'Save candidate sites, configure the scoring model, explain every score and compare two to five expansion options. It runs against the PostGIS workspace, so the fixture preview shows this section as a placeholder.',
  },
  Competitors: {
    phase: 'Phase 2–3',
    description: 'Manage normalized competitor datasets and inspect them as spatial layers.',
  },
  Datasets: {
    phase: 'Phase 5',
    description: 'Upload, validate and govern business datasets with a clear import audit trail.',
  },
  Analysis: {
    phase: 'Phase 4',
    description: 'Server-side PostGIS radius analysis will replace this preview with measured results.',
  },
  Reports: {
    phase: 'Phase 8',
    description: 'Export auditable analysis results as CSV, XLSX or GeoJSON, with PDF reports later.',
  },
  Settings: {
    phase: 'Phase 7',
    description: 'Organization, project and role-based workspace settings will be added with authentication.',
  },
};

export function ComingSoon({
  section,
  onReturnToMap,
}: {
  section: WorkspaceSection;
  onReturnToMap: () => void;
}) {
  const details = SECTION_DETAILS[section];

  return (
    <main className="coming-soon">
      <div className="coming-soon__card">
        <span className="coming-soon__icon" aria-hidden="true">
          <Layers3 size={22} strokeWidth={1.7} />
        </span>
        <span className="coming-soon__eyebrow">ROADMAP · {details.phase}</span>
        <h1>{section}</h1>
        <p>{details.description}</p>
        <div className="coming-soon__scope">
          <MapPinned aria-hidden="true" size={17} />
          <span>Phase 1 is focused on the Tashkent map workspace. This section is intentionally not backed by mock workflows.</span>
        </div>
        <button className="button button--primary" onClick={onReturnToMap} type="button">
          <ArrowLeft aria-hidden="true" size={16} />
          Return to map
        </button>
      </div>
    </main>
  );
}
