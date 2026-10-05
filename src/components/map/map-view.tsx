'use client';

import dynamic from 'next/dynamic';
import { LoaderCircle } from 'lucide-react';

import type { MapViewProps } from '@/components/map/map-types';

const InteractiveMap = dynamic(
  () => import('@/components/map/interactive-map').then((module) => module.InteractiveMap),
  {
    ssr: false,
    loading: () => (
      <div aria-label="Loading interactive map" className="map-loading" role="status">
        <span className="map-loading__spinner">
          <LoaderCircle aria-hidden="true" size={21} />
        </span>
        <span>Preparing the Tashkent map...</span>
      </div>
    ),
  },
);

export function MapView(props: MapViewProps) {
  return <InteractiveMap {...props} />;
}
