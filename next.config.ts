import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The hosted preview uses an e2b.app origin; allowing it keeps Next's dev
  // origin checks compatible with the browser preview without opening the
  // production app to arbitrary origins.
  allowedDevOrigins: ['*.e2b.app'],
};

export default nextConfig;
