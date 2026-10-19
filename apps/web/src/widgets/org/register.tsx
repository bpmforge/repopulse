import {
  registerWidget,
  type WidgetComponentProps,
} from '../../components/widget/WidgetRegistry.js';
import { KpiRow } from './KpiRow.js';
import { HealthTileGrid } from './HealthTileGrid.js';
import { AttentionFeed } from './AttentionFeed.js';
import { HotspotLeaderboard } from './HotspotLeaderboard.js';
import { TopActionsCard } from './TopActionsCard.js';
import { reposParam } from '../scopeRepos.js';

// Registry entries for the Org Overview widgets (W4-21, R-D2).
//
// This lives in widgets/org/ and not in components/widget/WidgetRegistry.tsx on
// purpose: components/ is the shared layer and must not import from widgets/.
// The registry is the seam — screens register into it, it does not reach out.
//
// Each component keeps its own props signature and gets a thin adapter that
// reads `window`/`search` out of widget.options. Rewriting four working widgets
// to take a `Widget` would have been a much larger change for no gain, and the
// grid engine already treats a widget's data source as its own business.

function optionsOf(widget: WidgetComponentProps['widget']): {
  window: string;
  search: Record<string, string>;
} {
  const options = widget.options ?? {};
  return {
    window: typeof options.window === 'string' ? options.window : '30d',
    search: (options.search as Record<string, string> | undefined) ?? {},
  };
}

registerWidget({
  type: 'top-actions',
  title: 'Next actions',
  category: 'lists',
  // Full width, two rows — three rows of action fit, and the card stays short
  // enough that its CONTENTS clear the fold at 1440x900 rather than just its
  // heading, which was the W17-17 defect. Registered here (not self-registered
  // at the bottom of its own module like PulseCard) so registerAll.ts, which
  // already imports this file, needs no edit: a saved view containing this type
  // resolves whether or not the org overview rendered first (W16-55).
  defaultSize: { w: 12, h: 2 },
  component: ({ widget }) => <TopActionsCard search={optionsOf(widget).search} />,
});

registerWidget({
  type: 'kpi',
  title: 'Delivery KPIs',
  category: 'metrics',
  // Full width, one row high. The five tiles inside it ARE the 1×1 cells R-D2
  // describes; they were not split into five registry widgets because that
  // would change the DOM the existing org-overview and a11y specs assert
  // against, and would look identical.
  defaultSize: { w: 12, h: 1 },
  component: ({ widget }) => {
    const { window, search } = optionsOf(widget);
    return <KpiRow window={window} repos={reposParam(search)} />;
  },
});

registerWidget({
  type: 'health-grid',
  title: 'Repo health',
  category: 'metrics',
  // A 2×2 HERO (R-D2): sizing variety is what makes a grid read as bento
  // rather than as a spreadsheet, and this is the tile people actually scan.
  defaultSize: { w: 6, h: 2 },
  component: ({ widget }) => {
    const { window, search } = optionsOf(widget);
    return <HealthTileGrid window={window} search={search} />;
  },
});

registerWidget({
  type: 'attention-feed',
  title: 'Needs attention',
  category: 'lists',
  defaultSize: { w: 6, h: 2 },
  component: ({ widget }) => {
    const { window, search } = optionsOf(widget);
    return <AttentionFeed window={window} search={search} />;
  },
});

registerWidget({
  type: 'hotspot-list',
  title: 'Hotspots',
  category: 'lists',
  defaultSize: { w: 12, h: 2 },
  component: ({ widget }) => {
    const { window, search } = optionsOf(widget);
    return <HotspotLeaderboard window={window} search={search} />;
  },
});
