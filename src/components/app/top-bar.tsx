'use client';

import { useMemo, useState } from 'react';
import {
  ArrowUpRight,
  Building2,
  MapPin,
  Search,
  UsersRound,
  X,
} from 'lucide-react';

import { type DemoLocation } from '@/lib/data/demo-locations';
import type { SelectedLocation } from '@/lib/domain/map-location';

interface TopBarProps {
  onSelectLocation: (location: SelectedLocation) => void;
  searchLocations: DemoLocation[];
}

function iconForLocation(location: DemoLocation) {
  if (location.kind === 'customers') return UsersRound;
  if (location.kind === 'branches' || location.kind === 'competitors') return Building2;
  return MapPin;
}

export function TopBar({ onSelectLocation, searchLocations }: TopBarProps) {
  const [query, setQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  const results = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();

    if (!normalizedQuery) return [];

    return searchLocations.filter((location) =>
      [location.name, location.category, location.address, location.kind]
        .join(' ')
        .toLocaleLowerCase()
        .includes(normalizedQuery),
    );
  }, [query, searchLocations]);

  const visibleResults = results.slice(0, 6);

  function chooseLocation(location: DemoLocation) {
    onSelectLocation(location);
    setQuery(location.name);
    setIsSearchOpen(false);
  }

  return (
    <header className="topbar">
      <div className="topbar-context">
        <span className="topbar-context__eyebrow">PILOT PROJECT</span>
        <span className="topbar-context__title">Store expansion</span>
        <span aria-hidden="true" className="topbar-context__separator">/</span>
        <span className="topbar-context__city">Tashkent</span>
      </div>

      <div className="topbar-search-wrap">
        <label className="topbar-search" htmlFor="workspace-search">
          <Search aria-hidden="true" size={17} strokeWidth={1.9} />
          <input
            autoComplete="off"
            id="workspace-search"
            onBlur={() => window.setTimeout(() => setIsSearchOpen(false), 120)}
            onChange={(event) => {
              setQuery(event.target.value);
              setIsSearchOpen(true);
            }}
            onFocus={() => setIsSearchOpen(true)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setIsSearchOpen(false);
              if (event.key === 'Enter' && results[0]) {
                event.preventDefault();
                chooseLocation(results[0]);
              }
            }}
            placeholder="Search places, businesses, categories..."
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={isSearchOpen && query.trim().length > 0}
            aria-controls="workspace-search-results"
            value={query}
          />
          {query ? (
            <button
              aria-label="Clear search"
              className="topbar-search__clear"
              onClick={() => {
                setQuery('');
                setIsSearchOpen(true);
              }}
              type="button"
            >
              <X aria-hidden="true" size={15} />
            </button>
          ) : (
            <span aria-hidden="true" className="topbar-search__hint">Search</span>
          )}
        </label>

        {isSearchOpen && query.trim() ? (
          <div className="search-results" id="workspace-search-results" role="listbox">
            {results.length ? (
              <>
                <p className="search-results__label">
                  SYNTHETIC DEMO DATA · {results.length > visibleResults.length
                    ? `TOP ${visibleResults.length} OF ${results.length}`
                    : results.length} RESULTS
                </p>
                {visibleResults.map((location) => {
                  const Icon = iconForLocation(location);

                  return (
                    <button
                      key={location.id}
                      className="search-result"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => chooseLocation(location)}
                      aria-selected={false}
                      role="option"
                      type="button"
                    >
                      <span
                        aria-hidden="true"
                        className={`search-result__icon search-result__icon--${location.kind}`}
                      >
                        <Icon size={15} strokeWidth={1.9} />
                      </span>
                      <span className="search-result__copy">
                        <span className="search-result__name">{location.name}</span>
                        <span className="search-result__detail">
                          {location.category} · {location.address}
                        </span>
                      </span>
                      <ArrowUpRight aria-hidden="true" className="search-result__arrow" size={15} />
                    </button>
                  );
                })}
              </>
            ) : (
              <div className="search-empty">
                <span className="search-empty__title">No demo data matches “{query}”</span>
                <span className="search-empty__detail">Search a loaded business, category or district. Move the map to load more.</span>
              </div>
            )}
          </div>
        ) : null}
      </div>

      <div className="topbar-actions">
        <span className="topbar-preview">
          <span aria-hidden="true" className="topbar-preview__dot" />
          Preview data
        </span>
        <div aria-label="Pilot workspace" className="topbar-avatar" title="Pilot workspace">
          AT
        </div>
      </div>
    </header>
  );
}
