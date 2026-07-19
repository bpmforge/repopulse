import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { Route as rootRoute } from './routes/__root.js';
import { createQueryClient } from './api/queryClient.js';
import { WidgetGrid } from './components/widget/WidgetGrid.js';
import { WidgetFrame } from './components/widget/WidgetFrame.js';
import './styles/theme.css';

// App bootstrap. W4-02 ships the shell + one placeholder home; the real screens
// (Org Overview, Repos, PR/file drill-down, …) are the remaining W4 route
// tickets, each adding a child route here (or migrating to file-based routing).
// Router type is intentionally NOT registered globally, so rail links to
// not-yet-built routes stay loosely typed and resolve to the not-found
// placeholder instead of failing to compile.

const queryClient = createQueryClient();

function HomePlaceholder() {
  return (
    <WidgetGrid
      widgets={[
        {
          id: 'welcome',
          type: 'text',
          layout: { x: 0, y: 0, w: 6, h: 2 },
          options: {
            title: 'Org Overview',
            text: 'The shell is live. Metric KPIs, health tiles, and the hotspot leaderboard land in the W4 screen tickets — this grid is the same engine that will render them.',
          },
        },
      ]}
    />
  );
}

function NotFoundPlaceholder() {
  return (
    <WidgetFrame
      title="Coming soon"
      state="empty"
      emptyMessage="This screen is part of a later W4 ticket. The shell, filters, and navigation already work."
    />
  );
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomePlaceholder,
});

const routeTree = rootRoute.addChildren([indexRoute]);

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultNotFoundComponent: NotFoundPlaceholder,
});

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('root element not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
