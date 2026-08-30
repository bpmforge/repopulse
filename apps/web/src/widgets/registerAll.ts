// EVERY widget type, registered once (W16-55).
//
// Widgets register themselves as a module SIDE EFFECT, and every one of those
// modules was reachable only through OrgOverview. So a saved view rendered
// "\"kpi\" widget is not available yet" for every tile it contained: the Views
// feature — templates, layouts, sharing, set-as-home — was a working shell over
// an empty registry, and whether it worked at all depended on whether you
// happened to pass through the org overview first in the same page load.
//
// Imported by the root route, so the registry is populated before any screen
// renders. A widget type added later belongs in this list, not in whichever
// screen first happens to need it.
import './org/register.js';
import './plans/PlanTile.js';
import './security/SecurityRollupTile.js';
import './risk/TopRisksCard.js';
import './risk/RiskAxesCard.js';
import './pulse/PulseCard.js';
// W16-55: the four types the view TEMPLATES ask for, which nothing registered.
import './views/register.js';
