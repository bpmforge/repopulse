import type { Widget } from '../components/widget/types.js';
import type { ViewConfig, ViewWindow } from './contracts.js';

// Persona starter templates (W5-02, UX_SPEC §6).
//
// An empty views list is the worst first screen in the product: it asks someone
// to design a dashboard before they know what the widgets mean. §6 answers that
// with starters per persona — the same four personas the shell already asks
// about on first login (W4-10), so the gallery can lead with the one they chose.

export interface ViewTemplate {
  id: string;
  persona: 'lead' | 'developer' | 'security' | 'exec';
  name: string;
  description: string;
  window: ViewWindow;
  widgets: Widget[];
}

const w = (id: string, type: Widget['type'], width: number, height: number): Widget => ({
  id,
  type,
  layout: { x: 0, y: 0, w: width, h: height },
});

export const VIEW_TEMPLATES: ViewTemplate[] = [
  {
    id: 'lead-delivery',
    persona: 'lead',
    name: 'Team delivery',
    description: 'Review coverage, cycle time and the repos that need attention this week.',
    window: '30d',
    widgets: [w('kpis', 'kpi', 12, 1), w('health', 'health-grid', 6, 2), w('attention', 'attention-feed', 6, 2)],
  },
  {
    id: 'developer-focus',
    persona: 'developer',
    name: 'My work',
    description: 'Your open pull requests and the reviews waiting on you.',
    window: '30d',
    widgets: [w('mine', 'my-prs', 6, 2), w('queue', 'my-queue', 6, 2), w('hotspots', 'hotspot-list', 12, 2)],
  },
  {
    id: 'security-risk',
    persona: 'security',
    name: 'Risk surface',
    description: 'Findings by severity and the files concentrated in one owner.',
    window: '90d',
    widgets: [w('findings', 'finding-table', 12, 2), w('hotspots', 'hotspot-list', 12, 2)],
  },
  {
    id: 'exec-rollup',
    persona: 'exec',
    name: 'Executive rollup',
    description: 'Org health and delivery trend, without per-person detail.',
    window: '90d',
    widgets: [w('kpis', 'kpi', 12, 1), w('trend', 'trend', 12, 2), w('health', 'health-grid', 12, 2)],
  },
];

/** The chosen persona's templates first — everyone else's stay available. */
export function templatesFor(persona: string | null | undefined): ViewTemplate[] {
  if (!persona) return VIEW_TEMPLATES;
  return [
    ...VIEW_TEMPLATES.filter((t) => t.persona === persona),
    ...VIEW_TEMPLATES.filter((t) => t.persona !== persona),
  ];
}

export function templateConfig(template: ViewTemplate): ViewConfig {
  return {
    // Empty = every repo in the workspace. A template cannot name repo ids it
    // has never seen, and guessing one would give a new user a dashboard
    // scoped to a repo they may not care about.
    repo_ids: [],
    window: template.window,
    layout: template.widgets.map((widget) => ({ id: widget.id, type: widget.type, layout: widget.layout })),
  };
}
