'use client';

import { useEffect } from 'react';
import { RefreshCw } from 'lucide-react';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Keep development diagnostics local until a privacy-reviewed reporter exists.
    if (process.env.NODE_ENV === 'development') {
      console.error('Location Intelligence app error:', error);
    }
  }, [error]);

  return (
    <main className="coming-soon" role="alert">
      <section className="coming-soon__card">
        <span aria-hidden="true" className="coming-soon__icon">
          <RefreshCw size={22} strokeWidth={1.7} />
        </span>
        <span className="coming-soon__eyebrow">WORKSPACE ERROR</span>
        <h1>We couldn’t load this view</h1>
        <p>
          The map workspace hit an unexpected error. Your browser location and map selection are not
          saved to a server in this preview.
        </p>
        {error.digest ? <p className="error-digest">Reference: {error.digest}</p> : null}
        <button className="button button--primary" onClick={reset} type="button">
          <RefreshCw aria-hidden="true" size={15} />
          Try again
        </button>
      </section>
    </main>
  );
}
