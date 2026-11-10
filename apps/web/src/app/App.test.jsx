import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

function mockFetch(status, body) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: status < 400,
    status,
    statusText: 'x',
    json: async () => body,
  });
}

describe('App shell', () => {
  it('renders the product heading and the synthetic-data banner', () => {
    mockFetch(200, { status: 'ok', dependencies: {} });
    renderApp();
    expect(screen.getByRole('heading', { name: 'Healthcare Operations OS' })).toBeInTheDocument();
    expect(screen.getByText(/synthetic data only/i)).toBeInTheDocument();
  });

  it('shows dependency status from the readiness endpoint', async () => {
    mockFetch(200, { status: 'ok', dependencies: { postgres: 'ok', redis: 'ok' } });
    renderApp();
    expect(await screen.findByText('PostgreSQL')).toBeInTheDocument();
    expect(screen.getByText('Redis')).toBeInTheDocument();
  });

  it('shows degraded dependencies when readiness returns 503', async () => {
    mockFetch(503, { status: 'degraded', dependencies: { postgres: 'ok', redis: 'unavailable' } });
    renderApp();
    expect(await screen.findByText('unavailable')).toBeInTheDocument();
  });

  it('explains how to start the API when it is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    renderApp();
    expect(await screen.findByText(/npm run dev:api/)).toBeInTheDocument();
  });
});
