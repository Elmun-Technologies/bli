'use client';

import {
  BarChart3,
  CircleHelp,
  Database,
  FileText,
  Gauge,
  Map,
  MapPinned,
  MapPinHouse,
  Settings2,
  Store,
  Upload,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';

export type WorkspaceSection =
  | 'Dashboard'
  | 'Map'
  | 'Import'
  | 'Customers'
  | 'Locations'
  | 'Competitors'
  | 'Datasets'
  | 'Analysis'
  | 'Reports'
  | 'Settings';

interface NavigationItem {
  label: WorkspaceSection;
  icon: LucideIcon;
  phase?: string;
}

const MAIN_NAVIGATION: NavigationItem[] = [
  { label: 'Dashboard', icon: Gauge, phase: 'Later' },
  { label: 'Map', icon: Map, phase: undefined },
  { label: 'Import', icon: Upload, phase: undefined },
  { label: 'Customers', icon: UsersRound, phase: 'Phase 5' },
  { label: 'Locations', icon: MapPinHouse, phase: 'Phase 6' },
  { label: 'Competitors', icon: Store, phase: 'Phase 2' },
];

const DATA_NAVIGATION: NavigationItem[] = [
  { label: 'Datasets', icon: Database, phase: 'Phase 5' },
  { label: 'Analysis', icon: BarChart3, phase: 'Phase 4' },
  { label: 'Reports', icon: FileText, phase: 'Phase 8' },
];

interface LeftSidebarProps {
  activeSection: WorkspaceSection;
  onNavigate: (section: WorkspaceSection) => void;
}

function NavigationGroup({
  title,
  items,
  activeSection,
  onNavigate,
}: {
  title: string;
  items: NavigationItem[];
  activeSection: WorkspaceSection;
  onNavigate: (section: WorkspaceSection) => void;
}) {
  return (
    <div className="sidebar-nav-group">
      <p className="sidebar-section-label">{title}</p>
      <nav aria-label={title} className="sidebar-nav">
        {items.map(({ label, icon: Icon, phase }) => (
          <button
            key={label}
            aria-current={activeSection === label ? 'page' : undefined}
            className={`sidebar-nav-item${activeSection === label ? ' is-active' : ''}`}
            onClick={() => onNavigate(label)}
            type="button"
          >
            <Icon aria-hidden="true" size={17} strokeWidth={1.8} />
            <span className="sidebar-nav-item__label">{label}</span>
            {phase ? <span className="sidebar-nav-item__phase">{phase}</span> : null}
          </button>
        ))}
      </nav>
    </div>
  );
}

export function LeftSidebar({ activeSection, onNavigate }: LeftSidebarProps) {
  return (
    <aside aria-label="Primary navigation" className="app-sidebar">
      <div className="sidebar-brand">
        <div aria-hidden="true" className="sidebar-brand__mark">
          <MapPinned size={20} strokeWidth={2} />
        </div>
        <div className="sidebar-brand__copy">
          <span className="sidebar-brand__name">ATLAS</span>
          <span className="sidebar-brand__descriptor">LOCATION INTELLIGENCE</span>
        </div>
      </div>

      <div className="workspace-switcher">
        <span aria-hidden="true" className="workspace-switcher__avatar">TI</span>
        <span className="workspace-switcher__copy">
          <span className="workspace-switcher__label">Pilot workspace</span>
          <span className="workspace-switcher__value">Tashkent · Uzbekistan</span>
        </span>
      </div>

      <div className="sidebar-navigation">
        <NavigationGroup
          activeSection={activeSection}
          items={MAIN_NAVIGATION}
          onNavigate={onNavigate}
          title="Workspace"
        />
        <NavigationGroup
          activeSection={activeSection}
          items={DATA_NAVIGATION}
          onNavigate={onNavigate}
          title="Insights & data"
        />
      </div>

      <div className="sidebar-bottom">
        <button
          aria-current={activeSection === 'Settings' ? 'page' : undefined}
          className={`sidebar-nav-item sidebar-settings${activeSection === 'Settings' ? ' is-active' : ''}`}
          onClick={() => onNavigate('Settings')}
          type="button"
        >
          <Settings2 aria-hidden="true" size={17} strokeWidth={1.8} />
          <span className="sidebar-nav-item__label">Settings</span>
          <span className="sidebar-nav-item__phase">Phase 7</span>
        </button>
        <div className="sidebar-help">
          <CircleHelp aria-hidden="true" size={16} strokeWidth={1.8} />
          <span className="sidebar-nav-item__label">Phase 1 · foundations</span>
        </div>
        <div className="sidebar-footer">
          <div aria-hidden="true" className="sidebar-footer__avatar">LI</div>
          <div className="sidebar-footer__copy">
            <span className="sidebar-footer__name">Location Intelligence</span>
            <span className="sidebar-footer__role">Pilot environment</span>
          </div>
          <span aria-label="Demo environment" className="sidebar-footer__status" />
        </div>
      </div>
    </aside>
  );
}
