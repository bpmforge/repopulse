# Hand-check marking sheet: W21-20 performance rules

Generated from the run described in [README.md](README.md). Each row is one hit. **Proposed** is Claude's reading, not the verdict. Fill the **Brad** column with `true`, `small` or `wrong` (or edit `sheet.csv`, which has the same rows). The recount uses your column only.

Labels: **true** = the shape is real and both inputs grow with data; **small** = real shape, but one input is small by design (counts as neither true nor wrong); **wrong** = not this shape.

## Proposed counts per rule

| Rule | Hits | true | small | wrong | pending | Proposed precision | ≥5 true and ≥80%? |
|---|--:|--:|--:|--:|--:|--:|---|
| `bpm-perf-copy-on-append` | 15 | 6 | 9 | 0 | 0 | 100% | yes (proposed) |
| `bpm-perf-find-by-key-in-loop` | 52 | 8 | 44 | 0 | 0 | 100% | yes (proposed) |
| `bpm-perf-find-by-key-in-loop-py` | 2 | 0 | 2 | 0 | 0 | — | no: fewer than 5 true |
| `bpm-perf-go-contains-in-loop` | 23 | 0 | 23 | 0 | 0 | — | no: fewer than 5 true |
| `bpm-perf-go-nested-range-join` | 21 | 6 | 15 | 0 | 0 | 100% | yes (proposed) |
| `bpm-perf-go-prepend-in-loop` | 1 | 0 | 0 | 1 | 0 | 0% | no: fewer than 5 true |
| `bpm-perf-includes-in-loop` | 200 | 48 | 138 | 14 | 0 | 77% | no: precision |
| `bpm-perf-java-contains-in-loop` | 30 | 7 | 23 | 0 | 0 | 100% | yes (proposed) |
| `bpm-perf-java-find-by-key-in-loop` | 11 | 1 | 9 | 1 | 0 | 50% | no: fewer than 5 true |
| `bpm-perf-java-remove-front-in-loop` | 2 | 0 | 1 | 1 | 0 | 0% | no: fewer than 5 true |
| `bpm-perf-kt-find-by-key-in-loop` | 8 | 1 | 7 | 0 | 0 | 100% | no: fewer than 5 true |
| `bpm-perf-membership-in-list-in-loop-py` | 28 | 15 | 13 | 0 | 0 | 100% | yes (proposed) |
| `bpm-perf-pop-front-in-loop-py` | 3 | 0 | 2 | 1 | 0 | 0% | no: fewer than 5 true |

## `bpm-perf-copy-on-append`

### #26 · excalidraw/excalidraw@b7de45e881 · `packages/excalidraw/components/ConvertElementTypePopup.tsx:442`

```
440:   const selectedElements = app.scene.getSelectedElements(app.state);
441: 
442:   const selectedElementIds = selectedElements.reduce(
443:     (acc, element) => ({ ...acc, [element.id]: true }),
444:     {},
445:   );
```

| Proposed | Reason | Brad |
|---|---|---|
| true | reduce spreads acc per selected element: O(k^2) copying; selections can be thousands of elements |  |

### #35 · excalidraw/excalidraw@b7de45e881 · `packages/excalidraw/components/UnlockPopup.tsx:71`

```
69:           const groupIds = selectGroupsFromGivenElements(elements, app.state);
70:           app.setState({
71:             selectedElementIds: elements.reduce(
72:               (acc, element) => ({
73:                 ...acc,
74:                 [element.id]: true,
```

| Proposed | Reason | Brad |
|---|---|---|
| true | reduce spreads acc per locked element being unlocked; O(k^2) in element count |  |

### #56 · outline/outline@670410b236 · `app/actions/definitions/documents.tsx:137`

```
135:   icon: <DocumentIcon />,
136:   children: ({ stores, activeDocumentId, t }) => {
137:     const nodes = stores.collections.navigationNodes.reduce(
138:       (acc, node) => [...acc, ...node.children],
139:       [] as NavigationNode[]
140:     );
```

| Proposed | Reason | Brad |
|---|---|---|
| true | reduce spreads growing node array per collection; total size = all top-level docs across collections |  |

### #57 · outline/outline@670410b236 · `app/actions/definitions/documents.tsx:1361`

```
1359:   icon: <ShuffleIcon />,
1360:   perform: ({ stores, activeDocumentId }) => {
1361:     const nodes = stores.collections.navigationNodes
1362:       .reduce((acc, node) => [...acc, ...node.children], [] as NavigationNode[])
1363:       .filter((node) => node.id !== activeDocumentId);
1364: 
```

| Proposed | Reason | Brad |
|---|---|---|
| true | same reduce-spread over collections' children; accumulator grows with doc count |  |

### #84 · outline/outline@670410b236 · `app/models/decorators/Field.ts:37`

```
35: const Field = (target: Model, propertyKey: string | symbol) => {
36:   const modelClass = target.constructor;
37:   fields.set(modelClass, [...(fields.get(modelClass) ?? []), propertyKey]);
38: };
39: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | per-model field registration at class decoration time; fields per model are tens, runs once |  |

### #395 · outline/outline@670410b236 · `shared/editor/lib/ExtensionManager.ts:181`

```
179: 
180:   get plugins() {
181:     return this.extensions
182:       .filter((extension) => "plugins" in extension)
183:       .reduce((allPlugins, { plugins }) => [...allPlugins, ...plugins], []);
184:   }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | reduce-spread over editor extensions; fixed set of a few dozen extensions |  |

### #396 · outline/outline@670410b236 · `shared/editor/lib/ExtensionManager.ts:187`

```
185: 
186:   get rulePlugins() {
187:     return this.extensions
188:       .filter((extension) => "rulePlugins" in extension)
189:       .reduce(
190:         (allRulePlugins, { rulePlugins }) => [
```

| Proposed | Reason | Brad |
|---|---|---|
| small | reduce-spread over editor extensions' rulePlugins; fixed small extension set |  |

### #397 · outline/outline@670410b236 · `shared/editor/lib/ExtensionManager.ts:236`

```
234:       });
235: 
236:     return [...extensionInputRules, ...nodeMarkInputRules].reduce(
237:       (allInputRules, inputRules) => [...allInputRules, ...inputRules],
238:       []
239:     );
```

| Proposed | Reason | Brad |
|---|---|---|
| small | reduce-spread over input rules from fixed extension set |  |

### #403 · outline/outline@670410b236 · `shared/editor/nodes/Heading.ts:171`

```
169: 
170:   keys({ type, schema }: { type: NodeType; schema: Schema }) {
171:     const options = this.options.levels.reduce(
172:       (items: Record<string, Command>, level: number) => ({
173:         ...items,
174:         [`Shift-Ctrl-${level}`]: toggleBlockType(type, schema.nodes.paragraph, {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | reduce-spread over heading levels (1-6) |  |

### #1493 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/pages/notification/settings/notification-settings.component.ts:93`

```
91:       }
92:       value[1].enabledDeliveryMethods = Object.assign(
93:         this.notificationDeliveryMethods.reduce((a, v) => ({ ...a, [v]: true}), {}),
94:         value[1].enabledDeliveryMethods
95:       );
```

| Proposed | Reason | Brad |
|---|---|---|
| small | reduce-spread over notification delivery methods enum (a few) |  |

### #1494 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/pages/notification/settings/notification-settings.component.ts:116`

```
114:             settings.forEach((setting) => {
115:               setting.enabled = true;
116:               setting.enabledDeliveryMethods = this.notificationDeliveryMethods.reduce((a, v) => ({ ...a, [v]: true}), {});
117:               notificationSettingsControls.push(this.fb.control(setting, [Validators.required]));
118:             });
```

| Proposed | Reason | Brad |
|---|---|---|
| small | reduce-spread over notification delivery methods enum (a few) |  |

### #1495 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/pages/notification/settings/notification-settings.component.ts:159`

```
157:         notificationType.enabled = value;
158:         notificationType.enabledDeliveryMethods =
159:           Object.keys(notificationType.enabledDeliveryMethods).reduce((a, v) => ({ ...a, [v]: value}), {});
160:       });
161:     }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | reduce-spread over delivery method keys (a few) |  |

### #1578 · prometheus/prometheus@a83f7158e7 · `web/ui/react-app/src/pages/alerts/AlertContents.tsx:176`

```
174: export const GroupInfo: FC<GroupInfoProps> = ({ rules, children }) => {
175:   // eslint-disable-next-line @typescript-eslint/no-explicit-any
176:   const statesCounter = rules.reduce<any>(
177:     (acc, r) => {
178:       return {
179:         ...acc,
```

| Proposed | Reason | Brad |
|---|---|---|
| small | reduce-spread acc has only the few alert-state keys; copy size constant |  |

### #1579 · prometheus/prometheus@a83f7158e7 · `web/ui/react-app/src/pages/targets/Filter.tsx:24`

```
22:   const allExpanded = Object.values(expanded).every((v: boolean): boolean => v);
23:   const mapExpansion = (next: boolean): Expanded =>
24:     Object.keys(expanded).reduce(
25:       (acc: { [scrapePool: string]: boolean }, scrapePool: string) => ({
26:         ...acc,
27:         [scrapePool]: next,
```

| Proposed | Reason | Brad |
|---|---|---|
| true | reduce-spread over scrape pool keys; O(k^2) with pools (can be hundreds) |  |

### #1580 · prometheus/prometheus@a83f7158e7 · `web/ui/react-app/src/pages/targets/ScrapePoolList.tsx:147`

```
145:   };
146: 
147:   const initialExpanded: Expanded = Object.keys(initialPoolList).reduce(
148:     (acc: { [scrapePool: string]: boolean }, scrapePool: string) => ({
149:       ...acc,
150:       [scrapePool]: true,
```

| Proposed | Reason | Brad |
|---|---|---|
| true | reduce-spread over scrape pools; O(k^2) with pool count |  |


## `bpm-perf-find-by-key-in-loop`

### #13 · excalidraw/excalidraw@b7de45e881 · `packages/element/src/sortElements.ts:93`

```
91:       element.type === "text" &&
92:       element.containerId &&
93:       elementsMap
94:         .get(element.containerId)
95:         ?.boundElements?.some((el) => el.id === element.id)
96:     ) {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | boundElements of one container (its text + bound arrows) is a handful; lookup is per element via elementsMap |  |

### #79 · outline/outline@670410b236 · `app/models/Group.ts:123`

```
121:     return groupMemberships.orderedData
122:       .filter((groupMembership) =>
123:         groupUsers.orderedData.some(
124:           (groupUser) =>
125:             groupUser.groupId === groupMembership.groupId &&
126:             groupUser.userId === auth.user?.id
```

| Proposed | Reason | Brad |
|---|---|---|
| true | groupMemberships x groupUsers.some(): both store-wide collections, grows with groups/users |  |

### #386 · outline/outline@670410b236 · `server/utils/authentication.ts:57`

```
55:   const teams = await Team.findAll({ where: { id: teamIds } });
56:   const team = teamIds
57:     .map((id) => teams.find((t) => t.id === id))
58:     .find((t) => t && !t.isSuspended && !t.isTeamUrl(ctx.href));
59:   if (!team) {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | teamIds come from sign-in cookies; a user is signed into a handful of teams |  |

### #389 · outline/outline@670410b236 · `server/utils/indexing.ts:73`

```
71:   const sortable = stars.sort(function (a, b) {
72:     return (
73:       documents.findIndex((d) => d.id === a.documentId) -
74:       documents.findIndex((d) => d.id === b.documentId)
75:     );
```

| Proposed | Reason | Brad |
|---|---|---|
| true | sort comparator does two findIndex scans of documents per comparison; stars per user grow |  |

### #436 · immich-app/immich@f7b8ae5da3 · `server/src/repositories/database.repository.ts:173`

```
171:     const promises = [];
172:     for (const indexName of names) {
173:       const row = rows.find((index) => index.indexname === indexName);
174:       const table = VECTOR_INDEX_TABLES[indexName];
175:       if (!row) {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | names = fixed vector index names (a couple); rows from pg_indexes for those names |  |

### #439 · immich-app/immich@f7b8ae5da3 · `server/src/repositories/integrity.repository.ts:50`

```
48: 
49:     return Object.fromEntries(
50:       Object.values(IntegrityReport).map((type) => [type, counts.find((count) => count.type === type)?.count || 0]),
51:     ) as Record<IntegrityReport, number>;
52:   }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | IntegrityReport enum values x grouped counts (one row per enum type) |  |

### #477 · immich-app/immich@f7b8ae5da3 · `server/src/services/duplicate.service.ts:251`

```
249: 
250:     const visibilityOrder = [AssetVisibility.Locked, AssetVisibility.Archive, AssetVisibility.Timeline];
251:     let visibility = visibilityOrder.find((level) => assets.some((asset) => asset.visibility === level));
252:     if (!visibility && assets.some((asset) => asset.visibility === AssetVisibility.Hidden)) {
253:       visibility = AssetVisibility.Hidden;
```

| Proposed | Reason | Brad |
|---|---|---|
| small | outer is fixed 3-element visibilityOrder; assets is one duplicate group, O(3n) not n*m |  |

### #512 · immich-app/immich@f7b8ae5da3 · `server/src/services/media.service.ts:785`

```
783: 
784:     for (const newFile of newFiles) {
785:       const existingFile = oldFiles.find((file) => file.type === newFile.type && file.isEdited === newFile.isEdited);
786:       if (existingFile) {
787:         toDelete.delete(existingFile);
```

| Proposed | Reason | Brad |
|---|---|---|
| small | newFiles x oldFiles of one asset: a few file types (thumbnail/preview/fullsize) per asset |  |

### #543 · immich-app/immich@f7b8ae5da3 · `server/src/services/storage-template.service.ts:191`

```
189: 
190:     for await (const asset of assets) {
191:       const user = users.find((user) => user.id === asset.ownerId);
192:       const storageLabel = user?.storageLabel || null;
193:       const filename = asset.originalFileName || asset.id;
```

| Proposed | Reason | Brad |
|---|---|---|
| true | streams every asset and does users.find per asset; O(assets*users), both data-derived |  |

### #910 · zulip/zulip@36d2312680 · `web/src/debug.ts:20`

```
18:     for (const o of document.querySelectorAll("*")) {
19:         if (o.id && ids.has(o.id)) {
20:             const el = collisions.find((c) => c.id === o.id);
21: 
22:             ids.add(o.id);
```

| Proposed | Reason | Brad |
|---|---|---|
| true | collisions.find per duplicate DOM id; DOM-size-derived (debug helper) |  |

### #1164 · paperless-ngx/paperless-ngx@5f17b1a310 · `src-ui/src/app/components/common/custom-field-display/custom-field-display.component.ts:121`

```
119:       .subscribe((result: Results<Document>) => {
120:         this.docLinkDocuments = this.value
121:           .map((id) => result.results.find((d) => d.id === id))
122:           .filter((d) => d)
123:         this.changeDetector.markForCheck()
```

| Proposed | Reason | Brad |
|---|---|---|
| true | doc-link ids x results.find; links per field data-derived (usually modest) |  |

### #1165 · paperless-ngx/paperless-ngx@5f17b1a310 · `src-ui/src/app/components/common/custom-fields-dropdown/custom-fields-dropdown.component.ts:105`

```
103:     this.unusedFields.set(
104:       this.customFields.filter(
105:         (f) => !this.existingFields?.find((e) => e.field === f.id)
106:       )
107:     )
```

| Proposed | Reason | Brad |
|---|---|---|
| small | customFields x existingFields; custom fields are a per-install config list (tens) |  |

### #1166 · paperless-ngx/paperless-ngx@5f17b1a310 · `src-ui/src/app/components/common/input/document-link/document-link.component.ts:110`

```
108:           this.loading.set(false)
109:           this.selectedDocuments = documentIDs.map(
110:             (id) => documentResults.results.find((d) => d.id === id) ?? { id }
111:           )
112:           super.writeValue(documentIDs)
```

| Proposed | Reason | Brad |
|---|---|---|
| true | selected doc ids x results.find; doc-link selections data-derived (usually modest) |  |

### #1167 · paperless-ngx/paperless-ngx@5f17b1a310 · `src-ui/src/app/components/common/input/document-link/document-link.component.ts:139`

```
137:                   (d) =>
138:                     d.id !== this.parentDocumentID &&
139:                     !this.selectedDocuments.find((sd) => sd.id === d.id)
140:                 )
141:               ),
```

| Proposed | Reason | Brad |
|---|---|---|
| small | title search results (truncated page) x manually selected docs |  |

### #1169 · paperless-ngx/paperless-ngx@5f17b1a310 · `src-ui/src/app/components/common/input/drag-drop-select/drag-drop-select.component.ts:44`

```
42:     this.selectedItems =
43:       newValue
44:         ?.map((id) => this.items.find((i) => i.id === id))
45:         .filter((item) => item) ?? []
46:   }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | selected ids x items: items is a fixed list of selectable fields |  |

### #1171 · paperless-ngx/paperless-ngx@5f17b1a310 · `src-ui/src/app/components/common/input/tags/tags.component.ts:227`

```
225:   get hasPrivate(): boolean {
226:     return this.value.some(
227:       (t) => this.tags?.find((t2) => t2.id === t) === undefined
228:     )
229:   }
```

| Proposed | Reason | Brad |
|---|---|---|
| true | doc tags x all tags list; tag catalogs can be thousands; getter may run per render |  |

### #1178 · paperless-ngx/paperless-ngx@5f17b1a310 · `src-ui/src/app/components/dashboard/widgets/saved-view-widget/saved-view-widget.component.ts:165`

```
163:     this.displayFields.set(
164:       this.displayFields().filter((field) =>
165:         this.settingsService.allDisplayFields().some((f) => f.id === field)
166:       )
167:     )
```

| Proposed | Reason | Brad |
|---|---|---|
| small | display fields x allDisplayFields: fixed built-in fields plus a few custom fields |  |

### #1181 · paperless-ngx/paperless-ngx@5f17b1a310 · `src-ui/src/app/services/document-list-view.service.ts:204`

```
202:         this.activeListViewState.displayFields =
203:           this.activeListViewState.displayFields.filter((field) =>
204:             this.settings.allDisplayFields().some((f) => f.id === field)
205:           )
206:         this.saveDocumentListView()
```

| Proposed | Reason | Brad |
|---|---|---|
| small | display fields x allDisplayFields: fixed small field list |  |

### #1182 · paperless-ngx/paperless-ngx@5f17b1a310 · `src-ui/src/app/services/document-list-view.service.ts:568`

```
566:     this.activeListViewState.displayFields = this.displayFieldsInitialized
567:       ? fields?.filter((field) =>
568:           this.settings.allDisplayFields().some((f) => f.id === field)
569:         )
570:       : fields
```

| Proposed | Reason | Brad |
|---|---|---|
| small | display fields x allDisplayFields: fixed small field list |  |

### #1187 · paperless-ngx/paperless-ngx@5f17b1a310 · `src-ui/src/app/services/rest/saved-view.service.ts:111`

```
109:     return sorted?.length > 0
110:       ? sorted
111:           .map((id) => sidebarViews.find((v) => v.id === id))
112:           .concat(sidebarViews.filter((v) => !sorted.includes(v.id)))
113:           .filter((v) => v)
```

| Proposed | Reason | Brad |
|---|---|---|
| small | sort-order ids x sidebarViews (find + includes); saved views per user are tens |  |

### #1189 · paperless-ngx/paperless-ngx@5f17b1a310 · `src-ui/src/app/services/rest/saved-view.service.ts:128`

```
126:     return sorted?.length > 0
127:       ? sorted
128:           .map((id) => dashboardViews.find((v) => v.id === id))
129:           .concat(dashboardViews.filter((v) => !sorted.includes(v.id)))
130:           .filter((v) => v)
```

| Proposed | Reason | Brad |
|---|---|---|
| small | sort-order ids x dashboardViews (find + includes); saved views per user are tens |  |

### #1397 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/core/services/resources.service.ts:52`

```
50:   for (const m of modulesWithComponentsList) {
51:     for (const module of m.modules) {
52:       if (!modulesWithComponents.modules.some(m1 => m1.module === module.module)) {
53:         modulesWithComponents.modules.push(module);
54:       }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | dedupe of Angular modules list; tens of modules |  |

### #1405 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/alias/entity-alias-dialog.component.ts:150`

```
148:     if (!isEmpty(this.alias.filter?.filters)) {
149:       this.alias.filter.filters = this.alias.filter.filters.filter((value, index, self) =>
150:         self.findIndex(v => v.relationType === value.relationType && isEqual(v.entityTypes, value.entityTypes)) === index &&
151:         (value.relationType || value.entityTypes?.length)
152:       );
```

| Proposed | Reason | Brad |
|---|---|---|
| small | findIndex dedupe of alias relation filters; a handful |  |

### #1425 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/role/operation-type-list.component.ts:205`

```
203:     if (this.operationTypeList && this.operationTypeList.length) {
204:       for (const operation of this.operationTypeList) {
205:         const result = this.allOperationTypeList.find(existingOperation => existingOperation.value === operation.value);
206:         if (result) {
207:           newList.push(result);
```

| Proposed | Reason | Brad |
|---|---|---|
| small | operation types x allOperationTypeList enum-sized list |  |

### #1428 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/rule-node/common/sv-map-config.component.ts:176`

```
174:     const deleteFieldsArray = [];
175:     for (const fieldMap of this.svListFormGroup.get('keyVals').value) {
176:       const findDeleteField = this.selectOptions.find((field) => field.value === fieldMap.key);
177:       if (findDeleteField) {
178:         deleteFieldsArray.push(findDeleteField);
```

| Proposed | Reason | Brad |
|---|---|---|
| small | keyVals x selectOptions: fixed field options list |  |

### #1429 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/rule-node/common/sv-map-config.component.ts:184`

```
182:     const filterSelectOptions = [];
183:     for (const selectOption of this.selectOptions) {
184:       if (!isDefinedAndNotNull(deleteFieldsArray.find((deleteField) => deleteField.value === selectOption.value)) ||
185:         selectOption.value === keyValControl?.get('key').value) {
186:         filterSelectOptions.push(selectOption);
```

| Proposed | Reason | Brad |
|---|---|---|
| small | selectOptions x deleteFieldsArray: fixed field options list |  |

### #1441 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/chart/latest-chart.ts:133`

```
131:       let value = 0;
132:       const tsValue = dsData.data[0];
133:       const dataItem = this.dataItems.find(item => item.dataKey === dsData.dataKey);
134:       if (tsValue && isDefinedAndNotNull(tsValue[1]) && isNumeric(tsValue[1])) {
135:         value = tsValue[1];
```

| Proposed | Reason | Brad |
|---|---|---|
| small | ctx.data x dataItems: widget data keys (config); could grow with multi-entity aliases |  |

### #1442 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/chart/latest-chart.ts:230`

```
228:         }
229:         if (this.settings.showLegend) {
230:           const legendItem = this.legendItems.find(item => item.dataKey === dataItem.dataKey);
231:           if (dataItem.hasValue) {
232:             legendItem.hasValue = true;
```

| Proposed | Reason | Brad |
|---|---|---|
| small | dataItems x legendItems: widget data keys (config) |  |

### #1446 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/chart/time-series-chart.models.ts:1332`

```
1330:       }
1331:       if (Array.isArray(options.series)) {
1332:         const series = options.series.find(s => s.id === item.id);
1333:         if (series) {
1334:           if (series.label?.show) {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | dataItems x options.series: chart series (config-sized) |  |

### #1449 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/chart/time-series-chart.ts:239`

```
237:   public update(): void {
238:     for (const item of this.dataItems) {
239:       const datasourceData = this.ctx.data ? this.ctx.data.find(d => d.dataKey === item.dataKey) : null;
240:       if (!isEqual(item.dataSet, datasourceData?.data)) {
241:         item.dataSet = datasourceData?.data;
```

| Proposed | Reason | Brad |
|---|---|---|
| small | dataItems x ctx.data per update: chart keys config-sized; grows with multi-entity datasources |  |

### #1450 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/chart/time-series-chart.ts:279`

```
277:       this.latestData = formattedDataFormDatasourceData(this.ctx.latestData);
278:       for (const item of this.dataItems) {
279:         let latestData = this.latestData.find(data => data.$datasource === item.datasource);
280:         if (!latestData) {
281:           latestData = {} as FormattedData;
```

| Proposed | Reason | Brad |
|---|---|---|
| small | dataItems x latestData by datasource: config-sized |  |

### #1451 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/chart/time-series-chart.ts:287`

```
285:       for (const item of this.thresholdItems) {
286:         if (item.settings.type === ValueSourceType.latestKey && item.latestDataKey) {
287:           const data = this.ctx.latestData.find(d => d.dataKey === item.latestDataKey);
288:           if (data.data[0]) {
289:             item.value = parseThresholdData(data.data[0][1], item.unitConvertor);
```

| Proposed | Reason | Brad |
|---|---|---|
| small | thresholds x latestData: a few thresholds |  |

### #1452 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/chart/time-series-chart.ts:299`

```
297:         const maxType = (yAxis.settings.max as ValueSourceConfig).type;
298:         if (minType === ValueSourceType.latestKey && yAxis.minLatestDataKey) {
299:           const data = this.ctx.latestData.find(d => d.dataKey === yAxis.minLatestDataKey);
300:           if (data?.data[0]) {
301:             const value = this.parseAxisLimitData(data.data[0][1], yAxis.unitConvertor);
```

| Proposed | Reason | Brad |
|---|---|---|
| small | loop over y-axes (a few) with find in latestData |  |

### #1453 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/chart/time-series-chart.ts:310`

```
308: 
309:         if (maxType === ValueSourceType.latestKey && yAxis.maxLatestDataKey) {
310:           const data = this.ctx.latestData.find(d => d.dataKey === yAxis.maxLatestDataKey);
311:           if (data?.data[0]) {
312:             const value = this.parseAxisLimitData(data.data[0][1], yAxis.unitConvertor);
```

| Proposed | Reason | Brad |
|---|---|---|
| small | loop over y-axes (a few) with find in latestData |  |

### #1454 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/chart/time-series-chart.ts:478`

```
476:           }
477:           dataKey.settings = keySettings;
478:           const datasourceData = this.ctx.data ? this.ctx.data.find(d => d.dataKey === dataKey) : null;
479:           const units: TbUnit = isNotEmptyTbUnits(dataKey.units) ? dataKey.units : this.ctx.units;
480:           const unitSymbol = this.unitService.getTargetUnitSymbol(units);
```

| Proposed | Reason | Brad |
|---|---|---|
| small | data keys x ctx.data during setup: config-sized |  |

### #1466 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/maps/map.ts:1302`

```
1300:     const itemData: DataKeyValuePair[] = [];
1301:     for (const dataKeyName of Object.keys(values)) {
1302:       const dataKey = dataKeys.find(key => key.name === dataKeyName);
1303:       if (dataKey) {
1304:         itemData.push({
```

| Proposed | Reason | Brad |
|---|---|---|
| small | saved value keys x datasource dataKeys: a few keys |  |

### #1470 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/scada/scada-symbol.models.ts:1038`

```
1036:     for (const id of ids) {
1037:       if (properties) {
1038:         found = properties.find(p => p.id === id);
1039:         if (found && found.type === FormPropertyType.fieldset) {
1040:           properties = found.properties;
```

| Proposed | Reason | Brad |
|---|---|---|
| small | walks a short id path through nested form properties; not a join |  |

### #1474 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/settings/common/action/location-keys-table.component.ts:158`

```
156:   private prepareKeysFormArray(value: LocationKeyMapping[] | undefined): FormArray {
157:     const mappings = (value || []).filter(mapping => this.availableKeys.includes(mapping?.argument));
158:     mandatoryLocationKeys.filter(argument => !mappings.some(mapping => mapping.argument === argument))
159:       .forEach((argument) => mappings.splice(mandatoryLocationKeys.indexOf(argument), 0,
160:         locationKeyMapping(argument)));
```

| Proposed | Reason | Brad |
|---|---|---|
| small | fixed mandatoryLocationKeys x mappings: a few |  |

### #1479 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/settings/common/dynamic-form/dynamic-form-property-panel.component.ts:269`

```
267:       if (multiple && FormPropertyType.select === type) {
268:         let targetValue: any[] = defaultValue;
269:         targetValue = targetValue.filter(valItem => !!items.find(item => item.value === valItem));
270:         this.propertyFormGroup.get('default').patchValue(targetValue, {emitEvent: false});
271:       } else {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | default values x select items: form config |  |

### #1481 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/settings/common/dynamic-form/dynamic-form.component.ts:238`

```
236:     for (const trigger of this.validatorTriggers) {
237:       const value: boolean = this.propertiesFormGroup.get(trigger).value;
238:       this.properties.filter(p => p.disableOnProperty === trigger).forEach(
239:         (p) => {
240:           p.disabled = !value;
```

| Proposed | Reason | Brad |
|---|---|---|
| small | validatorTriggers x properties: form config |  |

### #1482 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/settings/common/scada/scada-symbol-object-settings.models.ts:21`

```
19:       });
20:     } else {
21:       let behaviorGroup = result.find(g => g.title === behavior.group);
22:       if (!behaviorGroup) {
23:         behaviorGroup = {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | behaviors x groups of one SCADA symbol: config-sized |  |

### #1484 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/models/dashboard-component.models.ts:216`

```
214:     for (const w of Object.keys(this.widgetLayouts)) {
215:       const widgetLayout = this.widgetLayouts[w];
216:       const index = this.dashboardWidgets.findIndex((dashboardWidget) => dashboardWidget.widgetId === w);
217:       if (index > -1) {
218:         this.dashboardWidgets[index].widgetLayout = widgetLayout;
```

| Proposed | Reason | Brad |
|---|---|---|
| small | widgetLayouts x dashboardWidgets.findIndex: widgets per dashboard tens |  |

### #1488 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/pages/ai-solution-creator/overview/solution-creator-overview-entities.component.ts:374`

```
372:       if (!tId) continue;
373:       for (const c of customers) {
374:         if (!this.description.relations.some(x => x.child === c.name)) {
375:           const cId = nodeByName.get(c.name)?.id;
376:           if (cId) pushLink(tId, cId, 'Manages');
```

| Proposed | Reason | Brad |
|---|---|---|
| small | tenantUsers x customers x relations.some: AI-generated solution has tens of entities |  |

### #1489 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/pages/ai-solution-creator/overview/solution-creator-overview-entities.component.ts:387`

```
385:       for (const a of assets) {
386:         if (a.scope === c.name || a.scope === c.scope) {
387:           if (!this.description.relations.some(x => x.child === a.name)) {
388:             const aId = nodeByName.get(a.name)?.id;
389:             if (aId) pushLink(cId, aId, 'Own');
```

| Proposed | Reason | Brad |
|---|---|---|
| small | customers x assets x relations.some: AI-generated solution description, tens of entities |  |

### #1490 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/pages/ai-solution-creator/overview/solution-creator-overview-entities.component.ts:401`

```
399:       for (const d of devices) {
400:         if (d.scope === c.name || d.scope === c.scope) {
401:           if (!this.description.relations.some(x => x.child === d.name)) {
402:             const aId = nodeByName.get(d.name)?.id;
403:             if (aId) pushLink(cId, aId, 'Own');
```

| Proposed | Reason | Brad |
|---|---|---|
| small | customers x devices x relations.some: AI-generated solution description, tens of entities |  |

### #1491 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/pages/ai-solution-creator/overview/solution-creator-overview-entities.component.ts:415`

```
413:       for (const u of customerUsers) {
414:         if (u.scope === c.name || u.scope === c.scope) {
415:           if (!this.description.relations.some(x => x.child === u.name)) {
416:             const uId = nodeByName.get(u.name)?.id;
417:             if (uId) pushLink(cId, uId, 'Manages');
```

| Proposed | Reason | Brad |
|---|---|---|
| small | customers x users x relations.some: AI-generated solution description, tens of entities |  |

### #1496 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/pages/reporting/template/components/time-series-chart-preview.component.ts:217`

```
215:               datasource.latestDataKeys = [];
216:             }
217:             let dataKey = datasource.latestDataKeys.find(d => d.type === threshold.latestKeyType && d.name === threshold.latestKey);
218:             if (!dataKey) {
219:               dataKey = {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | thresholds x latestDataKeys of one chart: a few |  |

### #1497 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/pages/scada-symbol/metadata-components/scada-symbol-metadata-tags.component.ts:190`

```
188:     }));
189:     for (const tag of existing) {
190:       const found = result.find(t => t.tag === tag.tag);
191:       if (found) {
192:         found.stateRenderFunction = tag.stateRenderFunction;
```

| Proposed | Reason | Brad |
|---|---|---|
| small | existing tags x symbol tags of one SCADA symbol: a few |  |

### #1498 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/pages/scada-symbol/metadata-components/scada-symbol-metadata-tags.component.ts:203`

```
201:     }
202:     const tagRemoved = !!existing.find(existingTag =>
203:       !result.find(t => t.tag === existingTag.tag));
204:     return {
205:       tags: result,
```

| Proposed | Reason | Brad |
|---|---|---|
| small | existing tags x symbol tags of one SCADA symbol: a few |  |

### #1535 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/shared/models/dynamic-form.models.ts:300`

```
298:       }
299:     } else {
300:       let propertyGroup = groups.find(g => g.title === property.group);
301:       if (!propertyGroup) {
302:         propertyGroup = {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | properties x groups of a dynamic form: config-sized |  |

### #1540 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/shared/models/telemetry/telemetry.models.ts:591`

```
589:       const keyData = this.data[key];
590:       if (keyData.length) {
591:         const existing = origData.find((data) => data.key === key);
592:         if (existing) {
593:           existing.lastUpdateTs = keyData[0][0];
```

| Proposed | Reason | Brad |
|---|---|---|
| true | data keys x origData.find: entity attributes list can be hundreds |  |

### #1543 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/shared/models/widget/maps/map.models.ts:1508`

```
1506:   for (const sourceKey of source.dataKeys) {
1507:     const found =
1508:       target.dataKeys.find(key => key.type === sourceKey.type && key.name === sourceKey.name && key.label === sourceKey.label);
1509:     if (!found) {
1510:       appendKeys.push(sourceKey);
```

| Proposed | Reason | Brad |
|---|---|---|
| small | source x target dataKeys of map datasources: config-sized |  |


## `bpm-perf-find-by-key-in-loop-py`

### #1231 · paperless-ngx/paperless-ngx@5f17b1a310 · `src/documents/templating/filepath.py:321`

```
319:                 unicodedata.normalize(
320:                     "NFC",
321:                     next(
322:                         option["label"]
323:                         for option in options
324:                         if option["id"] == field_instance.value
```

| Proposed | Reason | Brad |
|---|---|---|
| small | next() over one select field's options per custom field; options are a short config list |  |

### #1232 · paperless-ngx/paperless-ngx@5f17b1a310 · `src/documents/templating/filepath.py:322`

```
320:                     "NFC",
321:                     next(
322:                         option["label"]
323:                         for option in options
324:                         if option["id"] == field_instance.value
325:                     ),
```

| Proposed | Reason | Brad |
|---|---|---|
| small | same generator as 1231 (select options of one field); short config list |  |


## `bpm-perf-go-contains-in-loop`

### #1554 · prometheus/prometheus@a83f7158e7 · `discovery/kubernetes/kubernetes.go:224`

```
222: 			return fmt.Errorf("invalid role: %q, expecting one of: pod, service, endpoints, endpointslice, node or ingress", c.Role)
223: 		}
224: 		if !slices.Contains(allowedSelectors[c.Role], string(selector.Role)) {
225: 			return fmt.Errorf("%s role supports only %s selectors", c.Role, strings.Join(allowedSelectors[c.Role], ", "))
226: 		}
```

| Proposed | Reason | Brad |
|---|---|---|
| small | selectors x allowedSelectors[role]: a few roles |  |

### #1556 · prometheus/prometheus@a83f7158e7 · `model/labels/labels_slicelabels.go:425`

```
423: 	res := make(Labels, 0, expectedSize)
424: 	for _, l := range b.base {
425: 		if slices.Contains(b.del, l.Name) || contains(b.add, l.Name) {
426: 			continue
427: 		}
```

| Proposed | Reason | Brad |
|---|---|---|
| small | base labels x b.del: labels per series ~10 (hot path but tiny lists) |  |

### #1563 · prometheus/prometheus@a83f7158e7 · `storage/remote/queue_manager.go:1040`

```
1038: 		staleVal := math.Float64frombits(value.StaleNaN)
1039: 		for i, prevBound := range prevBounds {
1040: 			if slices.Contains(customValues, prevBound) {
1041: 				continue
1042: 			}
```

| Proposed | Reason | Brad |
|---|---|---|
| small | prevBounds x customValues: histogram bucket bounds, tens |  |

### #1595 · go-gitea/gitea@85211296dd · `models/actions/run_attempt.go:128`

```
126: 		}
127: 		ids = append(ids, attempt.ID)
128: 		if !slices.Contains(passThroughAttemptIDs, attempt.ID) {
129: 			// stops at the first attempt that passed no job through
130: 			break
```

| Proposed | Reason | Brad |
|---|---|---|
| small | run attempts x passThroughAttemptIDs: a few attempts per job |  |

### #1605 · go-gitea/gitea@85211296dd · `models/issues/review_list.go:182`

```
180: 	countedReviewTypes := []ReviewType{ReviewTypeApprove, ReviewTypeReject, ReviewTypeRequest, ReviewTypeComment}
181: 	for _, review := range reviews {
182: 		if review.ReviewerTeamID == 0 && slices.Contains(countedReviewTypes, review.Type) && !review.Dismissed {
183: 			if review.OriginalAuthorID != 0 {
184: 				key := originalReviewer{id: review.OriginalAuthorID}
```

| Proposed | Reason | Brad |
|---|---|---|
| small | membership in fixed 4-element countedReviewTypes |  |

### #1606 · go-gitea/gitea@85211296dd · `models/project/workflows.go:174`

```
172: 	capabilities := wf.WorkflowEvent.Capabilities()
173: 	for _, typ := range wf.WorkflowFilters.Types() {
174: 		if !slices.Contains(capabilities.Filters, typ) {
175: 			return string(typ)
176: 		}
```

| Proposed | Reason | Brad |
|---|---|---|
| small | workflow filter types x capabilities: a few |  |

### #1607 · go-gitea/gitea@85211296dd · `models/project/workflows.go:179`

```
177: 	}
178: 	for _, typ := range wf.WorkflowActions.Types() {
179: 		if !slices.Contains(capabilities.Actions, typ) {
180: 			return string(typ)
181: 		}
```

| Proposed | Reason | Brad |
|---|---|---|
| small | workflow action types x capabilities: a few |  |

### #1612 · go-gitea/gitea@85211296dd · `models/unittest/mock_http.go:112`

```
110: 			}
111: 			for _, name := range slices.Sorted(maps.Keys(resp.Header)) {
112: 				if slices.Contains(ignoredHeaders, strings.ToLower(name)) {
113: 					continue
114: 				}
```

| Proposed | Reason | Brad |
|---|---|---|
| small | test helper: response headers x ignoredHeaders list |  |

### #1616 · go-gitea/gitea@85211296dd · `modules/markup/common/common.go:75`

```
73: 		linkifyRegexps := make([]string, 0, len(schemes))
74: 		for _, s := range schemes.Values() {
75: 			s += util.Iif(slices.Contains(xurls.SchemesNoAuthority, s), ":", "://")
76: 			linkifyRegexps = append(linkifyRegexps, regexp.QuoteMeta(s))
77: 		}
```

| Proposed | Reason | Brad |
|---|---|---|
| small | configured URL schemes x xurls.SchemesNoAuthority: small fixed lists |  |

### #1645 · go-gitea/gitea@85211296dd · `routers/web/explore/code.go:97`

```
95: 		loadRepoIDs := make([]int64, 0, len(searchResults))
96: 		for _, result := range searchResults {
97: 			if !slices.Contains(loadRepoIDs, result.RepoID) {
98: 				loadRepoIDs = append(loadRepoIDs, result.RepoID)
99: 			}
```

| Proposed | Reason | Brad |
|---|---|---|
| small | search results page x loadRepoIDs: bounded by page size |  |

### #1652 · go-gitea/gitea@85211296dd · `routers/web/user/code.go:90`

```
88: 		loadRepoIDs := make([]int64, 0, len(searchResults))
89: 		for _, result := range searchResults {
90: 			if !slices.Contains(loadRepoIDs, result.RepoID) {
91: 				loadRepoIDs = append(loadRepoIDs, result.RepoID)
92: 			}
```

| Proposed | Reason | Brad |
|---|---|---|
| small | search results page x loadRepoIDs: bounded by page size |  |

### #1656 · go-gitea/gitea@85211296dd · `services/auth/source/oauth2/providers.go:125`

```
123: 
124: 	for _, provider := range gothProviders {
125: 		if isAzureProvider(provider.Name()) && !slices.Contains(existingAzureSources, provider.Name()) {
126: 			continue
127: 		}
```

| Proposed | Reason | Brad |
|---|---|---|
| small | fixed goth providers x existing Azure sources |  |

### #1704 · traefik/traefik@f1f227eda7 · `cmd/internal/gen/centrifuge.go:84`

```
82: 
83: 	for _, p := range c.pkg.Imports() {
84: 		if slices.Contains(c.IncludedImports, p.Path()) {
85: 			fls := c.run(p.Scope(), p.Path(), p.Name())
86: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | codegen tool: imports x IncludedImports config list |  |

### #1705 · traefik/traefik@f1f227eda7 · `cmd/internal/gen/centrifuge.go:101`

```
99: 
100: 	for _, name := range sc.Names() {
101: 		if slices.Contains(c.ExcludedTypes, name) {
102: 			continue
103: 		}
```

| Proposed | Reason | Brad |
|---|---|---|
| small | codegen tool: scope names x ExcludedTypes config list |  |

### #1708 · traefik/traefik@f1f227eda7 · `pkg/config/runtime/runtime_http.go:30`

```
28: 		entryPointsCount := 0
29: 		for _, entryPointName := range rt.EntryPoints {
30: 			if !slices.Contains(entryPoints, entryPointName) {
31: 				rt.AddError(fmt.Errorf("entryPoint %q doesn't exist", entryPointName), false)
32: 				logger.Error().Str(logs.EntryPointName, entryPointName).
```

| Proposed | Reason | Brad |
|---|---|---|
| small | router entrypoints x configured entryPoints: a few entry points |  |

### #1709 · traefik/traefik@f1f227eda7 · `pkg/config/runtime/runtime_tcp.go:25`

```
23: 		entryPointsCount := 0
24: 		for _, entryPointName := range rt.EntryPoints {
25: 			if !slices.Contains(entryPoints, entryPointName) {
26: 				rt.AddError(fmt.Errorf("entryPoint %q doesn't exist", entryPointName), false)
27: 				logger.Error().Str(logs.EntryPointName, entryPointName).
```

| Proposed | Reason | Brad |
|---|---|---|
| small | router entrypoints x configured entryPoints: a few |  |

### #1710 · traefik/traefik@f1f227eda7 · `pkg/config/runtime/runtime_udp.go:29`

```
27: 		entryPointsCount := 0
28: 		for _, entryPointName := range eps {
29: 			if !slices.Contains(entryPoints, entryPointName) {
30: 				rt.AddError(fmt.Errorf("entryPoint %q doesn't exist", entryPointName), false)
31: 				logger.Error().Str(logs.EntryPointName, entryPointName).
```

| Proposed | Reason | Brad |
|---|---|---|
| small | router entrypoints x configured entryPoints: a few |  |

### #1711 · traefik/traefik@f1f227eda7 · `pkg/config/static/static_config.go:486`

```
484: 	if c.Providers != nil {
485: 		for _, providerName := range c.Providers.Precedence {
486: 			if !slices.Contains(providerNames, providerName) {
487: 				return fmt.Errorf("provider %q is not a valid provider name", providerName)
488: 			}
```

| Proposed | Reason | Brad |
|---|---|---|
| small | provider precedence x providerNames: a few |  |

### #1712 · traefik/traefik@f1f227eda7 · `pkg/middlewares/compress/compress.go:80`

```
78: 	}
79: 	for _, encoding := range conf.Encodings {
80: 		if !slices.Contains(defaultSupportedEncodings, encoding) {
81: 			return nil, fmt.Errorf("unsupported encoding: %s", encoding)
82: 		}
```

| Proposed | Reason | Brad |
|---|---|---|
| small | configured encodings x 3 supported encodings |  |

### #1715 · traefik/traefik@f1f227eda7 · `pkg/muxer/tcp/matcher_v2.go:62`

```
60: 	tree.matcher = func(meta ConnData) bool {
61: 		for _, proto := range meta.alpnProtos {
62: 			if slices.Contains(protos, proto) {
63: 				return true
64: 			}
```

| Proposed | Reason | Brad |
|---|---|---|
| small | client ALPN protos x configured protos: a few |  |

### #1718 · traefik/traefik@f1f227eda7 · `pkg/provider/kubernetes/gateway/client.go:862`

```
860: 	status := desired.DeepCopy()
861: 	for _, condition := range current.Conditions {
862: 		if !slices.Contains(gatewayConditionTypes, condition.Type) {
863: 			status.Conditions = append(status.Conditions, condition)
864: 		}
```

| Proposed | Reason | Brad |
|---|---|---|
| small | conditions x fixed gatewayConditionTypes |  |

### #1719 · traefik/traefik@f1f227eda7 · `pkg/provider/kubernetes/gateway/client.go:876`

```
874: 
875: 		for _, condition := range current.Listeners[idx].Conditions {
876: 			if !slices.Contains(listenerConditionTypes, condition.Type) {
877: 				status.Listeners[i].Conditions = append(status.Listeners[i].Conditions, condition)
878: 			}
```

| Proposed | Reason | Brad |
|---|---|---|
| small | listener conditions x fixed listenerConditionTypes |  |

### #1720 · traefik/traefik@f1f227eda7 · `pkg/provider/kubernetes/ingress/kubernetes.go:286`

```
284: 
285: 		// Middlewares and TLS options always contain cross-provider references.
286: 		if rtConfig != nil && rtConfig.Router != nil && p.CrossProviderNamespaces != nil && !slices.Contains(p.CrossProviderNamespaces, ingress.Namespace) {
287: 			if len(rtConfig.Router.Middlewares) > 0 {
288: 				logger.Error().Msgf("Skipping Ingress: cross-provider middleware reference is not allowed from namespace %q", ingress.Namespace)
```

| Proposed | Reason | Brad |
|---|---|---|
| small | CrossProviderNamespaces config list per ingress; a few namespaces |  |


## `bpm-perf-go-nested-range-join`

### #1555 · prometheus/prometheus@a83f7158e7 · `model/labels/labels_common.go:166`

```
164: func (b *Builder) Del(ns ...string) *Builder {
165: 	for _, n := range ns {
166: 		for i, a := range b.add {
167: 			if a.Name == n {
168: 				b.add = append(b.add[:i], b.add[i+1:]...)
169: 			}
```

| Proposed | Reason | Brad |
|---|---|---|
| small | del names x builder.add labels: a few labels |  |

### #1588 · go-gitea/gitea@85211296dd · `modelmigration/v1_11/v111.go:271`

```
269: 				err = sess.Where("team_id = ?", team.ID).Find(&teamU)
270: 
271: 				for _, tu := range teamU {
272: 					if tu.Type == u.Type {
273: 						unitEnabled = true
274: 						break
```

| Proposed | Reason | Brad |
|---|---|---|
| small | migration: unit types (fixed ~10) x teams x team units |  |

### #1596 · go-gitea/gitea@85211296dd · `models/activities/notification_list.go:255`

```
253: 		}
254: 		var found bool
255: 		for _, r := range reposList {
256: 			if r.ID == notification.RepoID {
257: 				found = true
258: 				break
```

| Proposed | Reason | Brad |
|---|---|---|
| true | notifications x deduped reposList scan; grows with notifications/repos per page |  |

### #1597 · go-gitea/gitea@85211296dd · `models/asymkey/gpg_key_add.go:112`

```
110: 						found := false
111: 
112: 						for _, originalSubkey := range original.Subkeys {
113: 							if originalSubkey.PublicKey == nil {
114: 								continue
115: 							}
```

| Proposed | Reason | Brad |
|---|---|---|
| small | GPG subkeys x original subkeys: a few |  |

### #1598 · go-gitea/gitea@85211296dd · `models/auth/oauth2.go:118`

```
116: 	for _, configName := range setting.OAuth2.DefaultApplications {
117: 		found := false
118: 		for clientID, builtinApp := range builtinApps {
119: 			if builtinApp.ConfigName == configName {
120: 				clientIDsToAdd.Add(clientID) // add all user-configured apps to the "add" list
121: 				found = true
```

| Proposed | Reason | Brad |
|---|---|---|
| small | default app config names x builtin apps (a few) |  |

### #1599 · go-gitea/gitea@85211296dd · `models/issues/issue_list.go:400`

```
398: 			continue
399: 		}
400: 		for _, pin := range issuePins {
401: 			if pin.IssueID == issue.ID {
402: 				issue.PinOrder = pin.PinOrder
403: 				break
```

| Proposed | Reason | Brad |
|---|---|---|
| small | issues x issuePins; pins are capped (max pinned issues per repo) |  |

### #1600 · go-gitea/gitea@85211296dd · `models/issues/issue_list.go:501`

```
499: 
500: 	for _, issueUser := range issueUsers {
501: 		for _, issue := range issues {
502: 			if issue.ID == issueUser.IssueID {
503: 				issue.IsRead = issueUser.IsRead
504: 			}
```

| Proposed | Reason | Brad |
|---|---|---|
| true | issueUsers x issues: both scale with issue list length |  |

### #1601 · go-gitea/gitea@85211296dd · `models/issues/issue_pin.go:195`

```
193: 	}
194: 	for _, issue := range issues {
195: 		for _, pin := range issuePins {
196: 			if pin.IssueID == issue.ID {
197: 				issue.PinOrder = pin.PinOrder
198: 				break
```

| Proposed | Reason | Brad |
|---|---|---|
| small | pinned issues x pins; capped max pinned count |  |

### #1602 · go-gitea/gitea@85211296dd · `models/issues/issue_xref.go:354`

```
352: 	for _, ref := range unfiltered {
353: 		found := false
354: 		for i, r := range refs {
355: 			if r.IssueID == ref.IssueID {
356: 				// Keep only the latest
357: 				refs[i] = ref
```

| Proposed | Reason | Brad |
|---|---|---|
| small | closing/reopening refs to one PR; dedupe over a few |  |

### #1608 · go-gitea/gitea@85211296dd · `models/repo/license.go:73`

```
71: 	for _, license := range licenses {
72: 		upd := false
73: 		for _, o := range oldLicenses {
74: 			// Update already existing license
75: 			if o.License == license.SPDXID {
76: 				o.CommitID = commitID
```

| Proposed | Reason | Brad |
|---|---|---|
| small | detected licenses x old licenses of one repo: a few |  |

### #1610 · go-gitea/gitea@85211296dd · `models/unit/unit.go:147`

```
145: 	// Remove disabled units
146: 	for _, disabledUnit := range DisabledRepoUnitsGet() {
147: 		for i, unit := range units {
148: 			if unit == disabledUnit {
149: 				units = append(units[:i], units[i+1:]...)
150: 			}
```

| Proposed | Reason | Brad |
|---|---|---|
| small | disabled units x fixed repo unit list |  |

### #1640 · go-gitea/gitea@85211296dd · `routers/api/packages/conda/conda.go:128`

```
126: 
127: 		var pfd *packages_model.PackageFileDescriptor
128: 		for _, d := range pd.Files {
129: 			if d.File.ID == pf.ID {
130: 				pfd = d
131: 				break
```

| Proposed | Reason | Brad |
|---|---|---|
| small | files of one package version (cached pd): a few files |  |

### #1641 · go-gitea/gitea@85211296dd · `routers/api/packages/rpm/rpm.go:392`

```
390: 
391: 		found := false
392: 		for i, existing := range vm.Updates {
393: 			if existing.ID == u.ID {
394: 				// Merge PkgList with deduplication
395: 				for _, newColl := range u.PkgList {
```

| Proposed | Reason | Brad |
|---|---|---|
| true | incoming updates x vm.Updates scan by ID; RPM updateinfo advisories grow with repo |  |

### #1642 · go-gitea/gitea@85211296dd · `routers/api/packages/rpm/rpm.go:400`

```
398: 					}
399: 					collFound := false
400: 					for j, existingColl := range existing.PkgList {
401: 						if existingColl.Short == newColl.Short {
402: 							// Merge packages
403: 							for _, newPkg := range newColl.Packages {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | pkg collections of one update: a few |  |

### #1649 · go-gitea/gitea@85211296dd · `routers/web/repo/issue_page_meta.go:496`

```
494: 			found := false
495: 		reviewAddLoop:
496: 			for _, tmp := range reviewersResult[:preadded] {
497: 				if tmp.ItemID == reviewer.ID {
498: 					tmp.User = reviewer
499: 					found = true
```

| Proposed | Reason | Brad |
|---|---|---|
| small | candidate reviewers x preadded review requests (a few) |  |

### #1650 · go-gitea/gitea@85211296dd · `routers/web/repo/issue_page_meta.go:524`

```
522: 			found := false
523: 		teamReviewAddLoop:
524: 			for _, tmp := range teamReviewersResult[:preadded] {
525: 				if tmp.ItemID == -team.ID {
526: 					tmp.Team = team
527: 					found = true
```

| Proposed | Reason | Brad |
|---|---|---|
| small | candidate teams x preadded team review requests (a few) |  |

### #1651 · go-gitea/gitea@85211296dd · `routers/web/repo/setting/public_access.go:107`

```
105: 	for _, ua := range accesses {
106: 		ua.FormKey = "repo-unit-access-" + strconv.Itoa(int(ua.UnitType))
107: 		for _, u := range ctx.Repo.Repository.Units {
108: 			if u.Type == ua.UnitType {
109: 				ua.UnitPublicAccess = paNotSet
110: 				switch {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | fixed accesses list x repo units (~10) |  |

### #1655 · go-gitea/gitea@85211296dd · `services/actions/job_emitter.go:292`

```
290: 		result.CancelledJobs = append(result.CancelledJobs, cancelledJobs...)
291: 		for _, cancelledJob := range cancelledJobs {
292: 			for _, job := range jobs {
293: 				if job.ID == cancelledJob.ID {
294: 					job.Status = cancelledJob.Status
295: 					break
```

| Proposed | Reason | Brad |
|---|---|---|
| true | cancelledJobs x jobs of a run; matrix runs can have hundreds of jobs |  |

### #1658 · go-gitea/gitea@85211296dd · `services/packages/rpm/repository.go:572`

```
570: 			for _, newColl := range u.PkgList {
571: 				collFound := false
572: 				for j, existingColl := range existing.PkgList {
573: 					if existingColl.Short == newColl.Short {
574: 						for _, newPkg := range newColl.Packages {
575: 							pkgFound := false
```

| Proposed | Reason | Brad |
|---|---|---|
| small | pkg collections of one update: a few |  |

### #1660 · go-gitea/gitea@85211296dd · `services/repository/commitstatus/commitstatus.go:166`

```
164: 
165: 	for _, summary := range summaryResults {
166: 		for i, repo := range repos {
167: 			if repo.ID == summary.RepoID {
168: 				summary.Repo = repo
169: 				results[i] = summary
```

| Proposed | Reason | Brad |
|---|---|---|
| true | summaryResults x repos list: both scale with repos listed |  |

### #1721 · traefik/traefik@f1f227eda7 · `pkg/provider/merge.go:225`

```
223: 	for _, certificate := range newCertificates {
224: 		var found bool
225: 		for _, existingCertificate := range certificates {
226: 			if existingCertificate.Certificate == certificate.Certificate {
227: 				found = true
228: 
```

| Proposed | Reason | Brad |
|---|---|---|
| true | newCertificates x certificates scan; TLS certs across providers can be hundreds+ |  |


## `bpm-perf-go-prepend-in-loop`

### #1557 · prometheus/prometheus@a83f7158e7 · `promql/functions.go:1080`

```
1078: 		case len(ss) == 1:
1079: 			if s.T < ss[0].T {
1080: 				ss = append([]sampleWithSt{s}, ss...)
1081: 			} else {
1082: 				ss = append(ss, s)
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | prepend only in len(ss)==1 case; ss is capped at 2 elements |  |


## `bpm-perf-includes-in-loop`

### #6 · excalidraw/excalidraw@b7de45e881 · `excalidraw-app/sentry.ts:17`

```
15:   !SENTRY_DISABLED &&
16:   Object.keys(SentryEnvHostnameMap).find(
17:     (item) => window.location.hostname.indexOf(item) >= 0,
18:   );
19: 
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | window.location.hostname is a string; indexOf is substring search over 3 fixed hostname keys |  |

### #7 · excalidraw/excalidraw@b7de45e881 · `packages/common/src/emitter.ts:37`

```
35:     const _handlers = handlers.flat();
36:     this.subscribers = this.subscribers.filter(
37:       (handler) => !_handlers.includes(handler),
38:     );
39:   }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | subscribers filtered against _handlers = the few handler args passed to off() |  |

### #10 · excalidraw/excalidraw@b7de45e881 · `packages/element/src/dragElements.ts:86`

```
84:   if (frames.length > 0) {
85:     for (const element of scene.getNonDeletedElements()) {
86:       if (element.frameId !== null && frames.includes(element.frameId)) {
87:         elementsToUpdate.add(element);
88:       }
```

| Proposed | Reason | Brad |
|---|---|---|
| true | all scene elements x ids of selected frames; both grow with the drawing, size unknown, data-derived |  |

### #11 · excalidraw/excalidraw@b7de45e881 · `packages/element/src/duplicate.ts:227`

```
225:     for (const groupId of Object.keys(opts.appState.selectedGroupIds)) {
226:       elements
227:         .filter((el) => el.groupIds?.includes(groupId))
228:         .forEach((el) => _idsOfElementsToDuplicate.set(el.id, el));
229:     }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | el.groupIds is one element's group nesting chain (a few ids); outer loop over all elements |  |

### #12 · excalidraw/excalidraw@b7de45e881 · `packages/element/src/elbowArrow.ts:291`

```
289:     arrow.fixedSegments?.map((segment) => segment.index) ?? [];
290:   const deletedSegmentIdx = oldFixedSegmentIndices.findIndex(
291:     (idx) => !newFixedSegmentIndices.includes(idx),
292:   );
293: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | fixed segment indices of a single elbow arrow; a handful per arrow |  |

### #14 · excalidraw/excalidraw@b7de45e881 · `packages/element/src/zindex.ts:175`

```
173:     containerElement?.id,
174:   ].filter((id): id is NonDeletedExcalidrawElement["id"] => !!id);
175:   const bindableIdx = elements.findIndex((el) => bindableIds.includes(el.id));
176:   const arrowIdx = elements.findIndex((el) => el.id === arrow.id);
177: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | bindableIds has at most 3 ids (hovered, bound text, container) |  |

### #15 · excalidraw/excalidraw@b7de45e881 · `packages/excalidraw/actions/actionBoundText.tsx:391`

```
389:         .map((el) => el.id);
390:       const linearElements = updatedElements.filter((ele) =>
391:         linearElementIds.includes(ele.id),
392:       ) as ExcalidrawLinearElement[];
393:       linearElements.forEach((ele) => {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | arrow ids bound to one text element (typically few) vs all updated elements |  |

### #21 · excalidraw/excalidraw@b7de45e881 · `packages/excalidraw/components/App.bucketFill.ts:241`

```
239:               common === null
240:                 ? groupIds
241:                 : common.filter((groupId) => groupIds.includes(groupId)),
242:             null as string[] | null,
243:           ) ?? [];
```

| Proposed | Reason | Brad |
|---|---|---|
| small | intersection of per-element groupIds arrays (group nesting depth, a few ids) |  |

### #23 · excalidraw/excalidraw@b7de45e881 · `packages/excalidraw/components/App.selection.ts:194`

```
192:     const boundElements = linear.boundElements?.map((def) => def.id) ?? [];
193:     const onlySingleLinearSelected = targetElements.every(
194:       (el) => el.id === linear.id || boundElements.includes(el.id),
195:     );
196: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | boundElements of one linear element (its labels, a few) vs selected elements |  |

### #25 · excalidraw/excalidraw@b7de45e881 · `packages/excalidraw/components/App.tsx:10852`

```
10850:           const allLibraryItems = await this.library.getLatestLibrary();
10851:           libraryItems = allLibraryItems.filter((item) =>
10852:             itemIds.includes(item.id),
10853:           );
10854:           // legacy library dataTransfer format
```

| Proposed | Reason | Brad |
|---|---|---|
| true | dropped library itemIds x whole library items; both user data, size unknown |  |

### #27 · excalidraw/excalidraw@b7de45e881 · `packages/excalidraw/components/LibraryMenuHeaderContent.tsx:36`

```
34:   libraryItems: LibraryItems,
35:   selectedItems: LibraryItem["id"][],
36: ) => libraryItems.filter((item) => selectedItems.includes(item.id));
37: 
38: export const LibraryDropdownMenuButton: React.FC<{
```

| Proposed | Reason | Brad |
|---|---|---|
| true | selectedItems ids x libraryItems; selection and library both grow with user data |  |

### #28 · excalidraw/excalidraw@b7de45e881 · `packages/excalidraw/components/LibraryMenuHeaderContent.tsx:94`

```
92:   const items = itemsSelected
93:     ? libraryItemsData.libraryItems.filter((item) =>
94:         selectedItems.includes(item.id),
95:       )
96:     : libraryItemsData.libraryItems;
```

| Proposed | Reason | Brad |
|---|---|---|
| true | selectedItems ids x libraryItems; selection and library both grow with user data |  |

### #29 · excalidraw/excalidraw@b7de45e881 · `packages/excalidraw/components/LibraryMenuHeaderContent.tsx:295`

```
293:   const removeFromLibrary = async (libraryItems: LibraryItems) => {
294:     const nextItems = libraryItems.filter(
295:       (item) => !selectedItems.includes(item.id),
296:     );
297:     library.setLibrary(nextItems).catch(() => {
```

| Proposed | Reason | Brad |
|---|---|---|
| true | selectedItems ids x libraryItems on remove; both data-derived |  |

### #30 · excalidraw/excalidraw@b7de45e881 · `packages/excalidraw/components/LibraryMenuItems.tsx:193`

```
191:       if (selectedItems.includes(id)) {
192:         targetElements = libraryItems.filter((item) =>
193:           selectedItems.includes(item.id),
194:         );
195:       } else {
```

| Proposed | Reason | Brad |
|---|---|---|
| true | selectedItems ids x libraryItems; both data-derived |  |

### #50 · excalidraw/excalidraw@b7de45e881 · `packages/fractional-indexing/src/index.ts:113`

```
111:   digits: string = BASE_62_DIGITS,
112: ): void {
113:   const validChars = key.split("").every((char) => digits.includes(char));
114:   if (key === `A${digits[0].repeat(26)}` || !validChars) {
115:     throw new Error(`invalid order key: ${key}`);
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | digits is a string (base-62 alphabet); includes is a character lookup, not array membership |  |

### #54 · outline/outline@670410b236 · `.oxlint/react-router.mjs:173`

```
171:                 entry.name !== node.name ||
172:                 entry.node.id === node ||
173:                 !ancestors.includes(entry.owner)
174:               ) {
175:                 continue;
```

| Proposed | Reason | Brad |
|---|---|---|
| small | ancestors = AST ancestor chain of one node (tree depth, bounded) vs tracked entries |  |

### #58 · outline/outline@670410b236 · `app/actions/index.ts:378`

```
376:   const applicableTypes = ["button", "link", "route", "group", "submenu"];
377:   return items.some(
378:     (item) => applicableTypes.includes(item.type) && item.visible
379:   );
380: }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | applicableTypes is a fixed 5-element literal |  |

### #61 · outline/outline@670410b236 · `app/components/DocumentExplorer/DocumentExplorer.tsx:220`

```
218:     }
219:     const ids = flatten(items.map(flattenTree))
220:       .filter((item) => deepExpandedNodes.includes(item.id))
221:       .flatMap(expandableDescendantIds);
222: 
```

| Proposed | Reason | Brad |
|---|---|---|
| true | deepExpandedNodes (alt-clicked ids, grows) x all flattened tree items; size unknown, data-derived |  |

### #62 · outline/outline@670410b236 · `app/components/DocumentExplorer/DocumentExplorer.tsx:232`

```
230:     collections.orderedData
231:       .filter(
232:         (collection) => expandedNodes.includes(collection.id) || searchTerm
233:       )
234:       .forEach((collection) => {
```

| Proposed | Reason | Brad |
|---|---|---|
| true | expandedNodes (incl. deep-expanded descendants, can be large) x collections |  |

### #63 · outline/outline@670410b236 · `app/components/FilterOptions.tsx:65`

```
63:   const [open, setOpen] = React.useState(false);
64:   const selectedItems = options.filter((option) =>
65:     selectedKeys.includes(option.key)
66:   );
67:   const [query, setQuery] = React.useState("");
```

| Proposed | Reason | Brad |
|---|---|---|
| true | selectedKeys x filter options (options can be users/collections); size unknown, data-derived |  |

### #65 · outline/outline@670410b236 · `app/components/Notifications/Notifications.tsx:49`

```
47:         ? active
48:         : active.filter((notification) =>
49:             Notification.filterCategories[filter].includes(notification.event)
50:           );
51: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | Notification.filterCategories[filter] is a fixed list of event types |  |

### #66 · outline/outline@670410b236 · `app/components/Sharing/Collection/AccessControlList.tsx:144`

```
142:                   .sort((a, b) =>
143:                     (
144:                       (invitedInSession.includes(a.group.id) ? "_" : "") +
145:                       a.group.name
146:                     ).localeCompare(b.group.name)
```

| Proposed | Reason | Brad |
|---|---|---|
| small | invitedInSession = ids invited in this dialog session (few) in sort comparator over group memberships |  |

### #67 · outline/outline@670410b236 · `app/components/Sharing/Collection/AccessControlList.tsx:206`

```
204:                   .sort((a, b) =>
205:                     (
206:                       (invitedInSession.includes(a.user.id) ? "_" : "") +
207:                       a.user.name
208:                     ).localeCompare(b.user.name)
```

| Proposed | Reason | Brad |
|---|---|---|
| small | invitedInSession = ids invited in this dialog session (few) in sort comparator over user memberships |  |

### #69 · outline/outline@670410b236 · `app/components/Sharing/Document/DocumentMemberList.tsx:142`

```
140:         .sort((a, b) =>
141:           (
142:             (invitedInSession.includes(a.group.id) ? "_" : "") + a.group.name
143:           ).localeCompare(
144:             (invitedInSession.includes(b.group.id) ? "_" : "") + b.group.name
```

| Proposed | Reason | Brad |
|---|---|---|
| small | invitedInSession = ids invited in this dialog session (few) in sort comparator over group memberships |  |

### #71 · outline/outline@670410b236 · `app/components/Sidebar/components/DraggableSection.tsx:51`

```
49: ): SidebarSection[] {
50:   const all = Object.values(SidebarSection);
51:   const valid = [...new Set(saved)].filter((section) => all.includes(section));
52:   return [...valid, ...all.filter((section) => !valid.includes(section))];
53: }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | all = Object.values(SidebarSection) enum, a handful of sections |  |

### #72 · outline/outline@670410b236 · `app/components/Sidebar/components/DraggableSection.tsx:52`

```
50:   const all = Object.values(SidebarSection);
51:   const valid = [...new Set(saved)].filter((section) => all.includes(section));
52:   return [...valid, ...all.filter((section) => !valid.includes(section))];
53: }
54: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | valid is a subset of SidebarSection enum values; both a handful |  |

### #73 · outline/outline@670410b236 · `app/components/Table.tsx:197`

```
195:       columns.filter(
196:         (column) =>
197:           !id || column.type !== "data" || !hiddenColumns.includes(column.id)
198:       ),
199:     [id, columns, hiddenColumns]
```

| Proposed | Reason | Brad |
|---|---|---|
| small | hiddenColumns x table columns; column definitions are a fixed small set |  |

### #74 · outline/outline@670410b236 · `app/components/Table.tsx:598`

```
596:   );
597:   const visibleCount = dataColumns.filter(
598:     (column) => !hiddenColumns.includes(column.id)
599:   ).length;
600: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | hiddenColumns x data columns of a table; fixed small set |  |

### #85 · outline/outline@670410b236 · `app/scenes/Document/components/Comments/LightboxComments.tsx:48`

```
46:     .threadsInDocument(document.id)
47:     .filter(
48:       (comment) => commentIds.includes(comment.id) && !comment.isResolved
49:     );
50: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | commentIds at one editor position (a few) vs document comment threads |  |

### #86 · outline/outline@670410b236 · `app/scenes/Document/components/References.tsx:202`

```
200:   if (sharedTree) {
201:     return flattenTree(sharedTree).filter((node) =>
202:       document.backlinkIds?.includes(node.id)
203:     ) as Document[];
204:   }
```

| Proposed | Reason | Brad |
|---|---|---|
| true | document.backlinkIds x flattened shared-tree nodes; both grow with documents |  |

### #88 · outline/outline@670410b236 · `app/stores/CollectionsStore.ts:204`

```
202:       (collection) =>
203:         collection.permission &&
204:         Object.values(CollectionPermission).includes(collection.permission)
205:     );
206:   }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | Object.values(CollectionPermission) is a small enum |  |

### #89 · outline/outline@670410b236 · `app/stores/GroupsStore.ts:38`

```
36:     const groupIds = memberships.map((member) => member.groupId);
37:     const groups = this.orderedData.filter((group) =>
38:       groupIds.includes(group.id)
39:     );
40: 
```

| Proposed | Reason | Brad |
|---|---|---|
| true | groupIds from collection memberships x all groups in store; both data-derived |  |

### #90 · outline/outline@670410b236 · `app/stores/GroupsStore.ts:57`

```
55:     const groupIds = memberships.map((member) => member.groupId);
56:     const groups = this.orderedData.filter(
57:       (group) => !groupIds.includes(group.id)
58:     );
59: 
```

| Proposed | Reason | Brad |
|---|---|---|
| true | groupIds from document memberships x all groups in store; both data-derived |  |

### #91 · outline/outline@670410b236 · `app/stores/GroupsStore.ts:76`

```
74:     const groupIds = memberships.map((member) => member.groupId);
75:     const groups = this.orderedData.filter(
76:       (group) => !groupIds.includes(group.id)
77:     );
78: 
```

| Proposed | Reason | Brad |
|---|---|---|
| true | groupIds from collection memberships x all groups in store; both data-derived |  |

### #92 · outline/outline@670410b236 · `app/stores/UsersStore.ts:163`

```
161:     const userIds = groupUsers.map((groupUser) => groupUser.userId);
162:     const users = this.activeOrInvited.filter(
163:       (user) => !userIds.includes(user.id)
164:     );
165:     return queriedUsers(users, query);
```

| Proposed | Reason | Brad |
|---|---|---|
| true | userIds of collection memberships x all active/invited users; both grow with team size |  |

### #93 · outline/outline@670410b236 · `app/stores/UsersStore.ts:174`

```
172:     const userIds = groupUsers.map((groupUser) => groupUser.userId);
173:     const users = this.activeOrInvited.filter((user) =>
174:       userIds.includes(user.id)
175:     );
176:     return queriedUsers(users, query);
```

| Proposed | Reason | Brad |
|---|---|---|
| true | userIds of collection memberships x all active/invited users; both grow with team size |  |

### #94 · outline/outline@670410b236 · `app/stores/UsersStore.ts:185`

```
183:     const userIds = groupUsers.map((groupUser) => groupUser.userId);
184:     const users = this.activeOrInvited.filter(
185:       (user) => !userIds.includes(user.id)
186:     );
187:     return queriedUsers(users, query);
```

| Proposed | Reason | Brad |
|---|---|---|
| true | userIds of group members x all active/invited users; both grow with team size |  |

### #95 · outline/outline@670410b236 · `app/stores/UsersStore.ts:196`

```
194:     const userIds = groupUsers.map((groupUser) => groupUser.userId);
195:     const users = this.activeOrInvited.filter((user) =>
196:       userIds.includes(user.id)
197:     );
198:     return queriedUsers(users, query);
```

| Proposed | Reason | Brad |
|---|---|---|
| true | userIds of group members x all active/invited users; both grow with team size |  |

### #107 · outline/outline@670410b236 · `plugins/discord/server/auth/discord.ts:178`

```
176:                 const { roles } = guildMember;
177:                 const hasRole = roles?.some((role) =>
178:                   env.DISCORD_SERVER_ROLES?.includes(role)
179:                 );
180: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | env.DISCORD_SERVER_ROLES is a configured comma list (few) vs member's roles |  |

### #111 · outline/outline@670410b236 · `plugins/github/server/GitHubIssueProvider.ts:205`

```
203:         );
204:         sources = sources.filter(
205:           (source) => !removedSourceIds.includes(source.id)
206:         );
207:       }
```

| Proposed | Reason | Brad |
|---|---|---|
| true | removed repo ids from webhook x integration issue sources (repos); both data-derived |  |

### #123 · outline/outline@670410b236 · `plugins/notion/server/tasks/NotionAPIImportTask.ts:157`

```
155:           error.code === APIErrorCode.Unauthorized ||
156:           this.skippableErrorMessages.some((errorMsg) =>
157:             error.message.includes(errorMsg)
158:           )
159:         ) {
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | error.message is a string; includes is substring search over a fixed error-message list |  |

### #124 · outline/outline@670410b236 · `plugins/search-postgres/server/PostgresSearchProvider.ts:905`

```
903:     );
904:     const remainder = terms
905:       .filter((term) => !identifiers.includes(term))
906:       .join(" ");
907: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | identifiers is capped by .slice(0, 3) |  |

### #127 · outline/outline@670410b236 · `plugins/webhooks/client/components/WebhookSubscriptionForm.tsx:195`

```
193:         const isGroupSelected = selectedGroups.includes(group);
194:         const selectedChildEvents = groupEvents.filter((event) =>
195:           events.includes(event)
196:         );
197:         const isPartiallySelected =
```

| Proposed | Reason | Brad |
|---|---|---|
| small | events (selected webhook events, bounded by fixed WEBHOOK_EVENTS) x a group's fixed event list |  |

### #161 · outline/outline@670410b236 · `server/commands/teamUpdater.ts:61`

```
59:     // Only keep existing domains if they are still in the list of allowed domains
60:     const newAllowedDomains = team.allowedDomains.filter((existingTeamDomain) =>
61:       allowedDomains.includes(existingTeamDomain.name)
62:     );
63: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | allowedDomains is a team's handful of configured email domains (limit-checked) |  |

### #162 · outline/outline@670410b236 · `server/commands/teamUpdater.ts:67`

```
65:     const existingDomains = team.allowedDomains.map((x) => x.name);
66:     const newDomains = allowedDomains.filter(
67:       (newDomain) => newDomain !== "" && !existingDomains.includes(newDomain)
68:     );
69:     // Created one at a time so that the limit check on each create counts the
```

| Proposed | Reason | Brad |
|---|---|---|
| small | existingDomains = team's few configured allowed domains |  |

### #164 · outline/outline@670410b236 · `server/commands/teamUpdater.ts:83`

```
81:     // Destroy the existing TeamDomains that were removed
82:     const deletedDomains = existingAllowedDomains.filter(
83:       (x) => !allowedDomains.includes(x.name)
84:     );
85:     await Promise.all(deletedDomains.map((x) => x.destroyWithCtx(ctx)));
```

| Proposed | Reason | Brad |
|---|---|---|
| small | allowedDomains is a team's handful of configured email domains |  |

### #169 · outline/outline@670410b236 · `server/converters/MimeArchiveConverter.ts:184`

```
182:       let replaced = false;
183:       for (const reference of references) {
184:         if (html.includes(reference)) {
185:           const dataUri = `data:${contentType};base64,${attachment.content.toString(
186:             "base64"
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | html is a string; includes is substring search per reference |  |

### #170 · outline/outline@670410b236 · `server/logging/Logger.ts:228`

```
226: 
227:       for (const key of Object.keys(output)) {
228:         if (sensitiveFields.includes(key)) {
229:           output[key] = "[Filtered]";
230:         } else if (isObject(output[key])) {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | sensitiveFields is a fixed list of field names |  |

### #171 · outline/outline@670410b236 · `server/main.ts:115`

```
113:   // loop through requested services at startup
114:   for (const name of env.SERVICES) {
115:     if (!Object.keys(services).includes(name)) {
116:       throw new Error(`Unknown service ${name}`);
117:     }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | Object.keys(services) is a fixed set of service names; env.SERVICES a few |  |

### #196 · outline/outline@670410b236 · `server/models/base/Model.ts:518`

```
516: 
517:       if (
518:         virtualFields.includes(String(change)) ||
519:         blobFields.includes(String(change)) ||
520:         skippedFields.includes(String(change))
```

| Proposed | Reason | Brad |
|---|---|---|
| small | virtualFields: static per-model field-name list, a few entries |  |

### #197 · outline/outline@670410b236 · `server/models/base/Model.ts:519`

```
517:       if (
518:         virtualFields.includes(String(change)) ||
519:         blobFields.includes(String(change)) ||
520:         skippedFields.includes(String(change))
521:       ) {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | blobFields: static per-model field-name list, a few entries |  |

### #198 · outline/outline@670410b236 · `server/models/base/Model.ts:520`

```
518:         virtualFields.includes(String(change)) ||
519:         blobFields.includes(String(change)) ||
520:         skippedFields.includes(String(change))
521:       ) {
522:         continue;
```

| Proposed | Reason | Brad |
|---|---|---|
| small | skippedFields: per-instance changeset-skip list, a few field names |  |

### #256 · outline/outline@670410b236 · `server/queues/tasks/CommentCreatedNotificationsTask.ts:54`

```
52: 
53:     for (const mention of mentions) {
54:       if (userIdsMentioned.includes(mention.modelId)) {
55:         continue;
56:       }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | dedupe of user mentions in a single comment (a few); each iteration awaits a DB lookup |  |

### #260 · outline/outline@670410b236 · `server/queues/tasks/CommentCreatedNotificationsTask.ts:91`

```
89:     const mentionedGroup: string[] = [];
90:     for (const group of groupMentions) {
91:       if (mentionedGroup.includes(group.modelId)) {
92:         continue;
93:       }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | dedupe of group mentions in a single comment (a few) |  |

### #263 · outline/outline@670410b236 · `server/queues/tasks/CommentCreatedNotificationsTask.ts:119`

```
117:         comment.createdById
118:       )
119:     ).filter((recipient) => !userIdsMentioned.includes(recipient.id));
120: 
121:     await sequelize.transaction(async (transaction) => {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | userIdsMentioned = users mentioned in one comment (few) vs notification recipients |  |

### #265 · outline/outline@670410b236 · `server/queues/tasks/CommentUpdatedNotificationsTask.ts:43`

```
41:       ProsemirrorHelper.toProsemirror(comment.data),
42:       { type: MentionType.User }
43:     ).filter((mention) => newMentionIds.includes(mention.id));
44:     const userIdsMentioned: string[] = [];
45: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | newMentionIds = mentions added in one comment edit (few) vs comment's mentions |  |

### #266 · outline/outline@670410b236 · `server/queues/tasks/CommentUpdatedNotificationsTask.ts:47`

```
45: 
46:     for (const mention of mentions) {
47:       if (userIdsMentioned.includes(mention.modelId)) {
48:         continue;
49:       }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | dedupe of user mentions in a single comment (a few) |  |

### #270 · outline/outline@670410b236 · `server/queues/tasks/CommentUpdatedNotificationsTask.ts:77`

```
75:       ProsemirrorHelper.toProsemirror(comment.data),
76:       { type: MentionType.Group }
77:     ).filter((mention) => newMentionIds.includes(mention.id));
78: 
79:     const mentionedGroup: string[] = [];
```

| Proposed | Reason | Brad |
|---|---|---|
| small | newMentionIds = mentions added in one comment edit (few) vs group mentions |  |

### #271 · outline/outline@670410b236 · `server/queues/tasks/CommentUpdatedNotificationsTask.ts:81`

```
79:     const mentionedGroup: string[] = [];
80:     for (const group of groupMentions) {
81:       if (mentionedGroup.includes(group.modelId)) {
82:         continue;
83:       }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | dedupe of group mentions in a single comment (a few) |  |

### #274 · outline/outline@670410b236 · `server/queues/tasks/CommentUpdatedNotificationsTask.ts:142`

```
140: 
141:       for (const userId of userIds) {
142:         if (userIdsNotified.includes(userId)) {
143:           continue;
144:         }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | userIdsNotified = participants of one comment thread (tens at most); per-iteration DB awaits dominate |  |

### #284 · outline/outline@670410b236 · `server/queues/tasks/DocumentPublishedNotificationsTask.ts:75`

```
73:     const mentionedGroup: string[] = [];
74:     for (const group of groupMentions) {
75:       if (mentionedGroup.includes(group.modelId)) {
76:         continue;
77:       }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | dedupe of group mentions in one document (few) |  |

### #287 · outline/outline@670410b236 · `server/queues/tasks/DocumentPublishedNotificationsTask.ts:96`

```
94:       const mentionedUser: string[] = [];
95:       for (const user of usersFromMentionedGroup) {
96:         if (mentionedUser.includes(user.userId)) {
97:           continue;
98:         }
```

| Proposed | Reason | Brad |
|---|---|---|
| true | mentionedUser dedupe grows to group size over all GroupUser rows of a group; O(g^2), though DB awaits dominate |  |

### #291 · outline/outline@670410b236 · `server/queues/tasks/DocumentPublishedNotificationsTask.ts:131`

```
129:         actorId: document.lastModifiedById,
130:       })
131:     ).filter((recipient) => !userIdsMentioned.includes(recipient.id));
132: 
133:     for (const recipient of recipients) {
```

| Proposed | Reason | Brad |
|---|---|---|
| true | userIdsMentioned (users mentioned in doc) x doc notification recipients; size unknown, data-derived |  |

### #320 · outline/outline@670410b236 · `server/queues/tasks/RevisionCreatedNotificationsTask.ts:110`

```
108:     const mentionedGroup: string[] = [];
109:     for (const group of groupMentions) {
110:       if (mentionedGroup.includes(group.modelId)) {
111:         continue;
112:       }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | dedupe of newly added group mentions in one revision (few) |  |

### #323 · outline/outline@670410b236 · `server/queues/tasks/RevisionCreatedNotificationsTask.ts:131`

```
129:       const mentionedUser: string[] = [];
130:       for (const user of usersFromMentionedGroup) {
131:         if (mentionedUser.includes(user.userId)) {
132:           continue;
133:         }
```

| Proposed | Reason | Brad |
|---|---|---|
| true | mentionedUser dedupe grows to group size over all GroupUser rows of a group; O(g^2), though DB awaits dominate |  |

### #327 · outline/outline@670410b236 · `server/queues/tasks/RevisionCreatedNotificationsTask.ts:177`

```
175:         actorId: document.lastModifiedById,
176:       })
177:     ).filter((recipient) => !userIdsMentioned.includes(recipient.id));
178:     if (!recipients.length) {
179:       return;
```

| Proposed | Reason | Brad |
|---|---|---|
| true | userIdsMentioned (users mentioned in doc) x doc notification recipients; size unknown, data-derived |  |

### #347 · outline/outline@670410b236 · `server/routes/api/auth/auth.ts:177`

```
175:           presentAvailableTeam(
176:             availableTeam,
177:             signedInTeamIds.includes(availableTeam.id) ||
178:               availableTeam.id === user.teamId
179:           )
```

| Proposed | Reason | Brad |
|---|---|---|
| small | signedInTeamIds = teams the user is signed into (a handful) vs available teams |  |

### #393 · outline/outline@670410b236 · `shared/editor/lib/ExtensionManager.ts:96`

```
94:         nodes[i].marks = marks
95:           .split(" ")
96:           .filter((m: string) => Object.keys(this.marks).includes(m))
97:           .join(" ");
98:       }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | Object.keys(this.marks) = editor mark types (~20 fixed) vs a node's mark names |  |

### #394 · outline/outline@670410b236 · `shared/editor/lib/ExtensionManager.ts:118`

```
116:         marks[i].excludes = excludes
117:           .split(" ")
118:           .filter((m: string) => Object.keys(marks).includes(m))
119:           .join(" ");
120:       }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | Object.keys(marks) = editor mark types (~20 fixed) vs a mark's excludes names |  |

### #408 · outline/outline@670410b236 · `shared/utils/currency.ts:62`

```
60:   // Must contain at least one currency symbol
61:   const hasCurrencySymbol = currencySymbols.some((symbol) =>
62:     trimmed.includes(symbol)
63:   );
64:   if (!hasCurrencySymbol) {
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | trimmed is a string; includes is substring search over a fixed currency-symbol list |  |

### #419 · immich-app/immich@f7b8ae5da3 · `packages/cli/src/utils.ts:61`

```
59: 
60:   for (const permission of permissions) {
61:     if (!_apiKey.permissions.includes(permission)) {
62:       missing.push(permission);
63:     }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | api key permissions bounded by the Permission enum vs the few permissions requested |  |

### #421 · immich-app/immich@f7b8ae5da3 · `packages/plugin-core/src/index.ts:188`

```
186: 
187:     for (const tag of config.tags) {
188:       if (assetTags.includes(tag)) {
189:         if (config.matching === 'any') {
190:           return { workflow: { continue: true } };
```

| Proposed | Reason | Brad |
|---|---|---|
| small | one asset's tag ids x workflow config tags; both a handful |  |

### #444 · immich-app/immich@f7b8ae5da3 · `server/src/repositories/machine-learning.repository.ts:102`

```
100:     // delete old servers
101:     for (const url of Object.keys(this.healthyMap)) {
102:       if (!config.urls.includes(url)) {
103:         delete this.healthyMap[url];
104:       }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | config.urls = configured ML server URLs (a few) |  |

### #474 · immich-app/immich@f7b8ae5da3 · `server/src/services/duplicate.service.ts:127`

```
125: 
126:     for (const assetId of groupAssetIds) {
127:       if (idsToKeep.includes(assetId) && idsToTrash.includes(assetId)) {
128:         return {
129:           id: duplicateId,
```

| Proposed | Reason | Brad |
|---|---|---|
| small | idsToKeep/idsToTrash within one duplicate group (a few assets) |  |

### #475 · immich-app/immich@f7b8ae5da3 · `server/src/services/duplicate.service.ts:136`

```
134:       }
135: 
136:       if (!idsToKeep.includes(assetId) && !idsToTrash.includes(assetId)) {
137:         return {
138:           id: duplicateId,
```

| Proposed | Reason | Brad |
|---|---|---|
| small | idsToKeep/idsToTrash within one duplicate group (a few assets) |  |

### #541 · immich-app/immich@f7b8ae5da3 · `server/src/services/shared-link.service.ts:202`

```
200:     const results: AssetIdsResponseDto[] = [];
201:     for (const assetId of dto.assetIds) {
202:       const wasRemoved = removedAssetIds.includes(assetId);
203:       if (!wasRemoved) {
204:         results.push({ assetId, success: false, error: AssetIdErrorReason.NOT_FOUND });
```

| Proposed | Reason | Brad |
|---|---|---|
| true | dto.assetIds from request x removedAssetIds from DB; both request-sized, can be large |  |

### #636 · immich-app/immich@f7b8ae5da3 · `server/src/services/workflow-execution.service.ts:399`

```
397:     let type: T | undefined;
398:     for (const targetType of Object.values(WorkflowType)) {
399:       const isMissing = workflow.steps.some((step) => !step.types.includes(targetType));
400:       if (!isMissing) {
401:         type = targetType as unknown as T;
```

| Proposed | Reason | Brad |
|---|---|---|
| small | WorkflowType enum x workflow steps x step.types (a few each) |  |

### #654 · immich-app/immich@f7b8ae5da3 · `server/src/utils/workflow.ts:36`

```
34:   for (const requested of validTypes) {
35:     for (const pluginCompatibilityGroup of pluginCompatibility) {
36:       if (pluginCompatibilityGroup.includes(requested)) {
37:         return true;
38:       }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | triggerMap types x plugin method types with implied items; small fixed enums |  |

### #663 · immich-app/immich@f7b8ae5da3 · `web/src/lib/queries/notification.query.ts:25`

```
23:       queryClient.setQueryData(getNotificationsQuery().queryKey, (notifications) =>
24:         notifications?.filter(
25:           (item) => !notificationUpdateAllDto.ids.includes(item.id) || !notificationUpdateAllDto.readAt,
26:         ),
27:       ),
```

| Proposed | Reason | Brad |
|---|---|---|
| true | notificationUpdateAllDto.ids x cached notifications list; both data-derived |  |

### #668 · immich-app/immich@f7b8ae5da3 · `web/src/lib/utils.ts:338`

```
336:     const values = ['autoLaunch=0', 'password=1', 'password=true'];
337:     for (const value of values) {
338:       if (location.search.includes(value)) {
339:         return true;
340:       }
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | location.search is a string; includes is substring search |  |

### #899 · zulip/zulip@36d2312680 · `web/src/add_group_members_pill.ts:46`

```
44: 
45:     for (const member_id of direct_member_ids) {
46:         if (!taken_user_ids.includes(member_id)) {
47:             const user = people.get_by_user_id(member_id);
48:             user_pill.append_user(user, pill_widget, false);
```

| Proposed | Reason | Brad |
|---|---|---|
| true | taken_user_ids (pill widget users) x group members; both grow with users |  |

### #900 · zulip/zulip@36d2312680 · `web/src/add_group_members_pill.ts:53`

```
51: 
52:     for (const group_id of direct_subgroup_ids) {
53:         if (!taken_group_ids.includes(group_id)) {
54:             const subgroup = user_groups.get_user_group_from_id(group_id);
55:             user_group_pill.append_user_group(subgroup, pill_widget, false, true);
```

| Proposed | Reason | Brad |
|---|---|---|
| small | taken_group_ids (group pills, few) x a group's direct subgroups (few) |  |

### #902 · zulip/zulip@36d2312680 · `web/src/billing/helpers.ts:76`

```
74: 
75:     for (const item of $form.serializeArray()) {
76:         if (ignored_inputs.includes(item.name)) {
77:             continue;
78:         }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | ignored_inputs is a fixed list of form field names |  |

### #907 · zulip/zulip@36d2312680 · `web/src/compose_paste.ts:175`

```
173:     if (
174:         !html_outer.includes("<!--StartFragment-->") ||
175:         excel_namespaces.every((ns) => !html_outer.includes(ns))
176:     ) {
177:         return false;
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | html_outer is a string; includes is substring search over fixed excel namespaces |  |

### #914 · zulip/zulip@36d2312680 · `web/src/emoji_picker.ts:445`

```
443:             for (const emoji_dict of emojis) {
444:                 for (const alias of emoji_dict.aliases) {
445:                     const match = search_terms.every((search_term) => alias.includes(search_term));
446:                     if (match) {
447:                         search_results.push({...emoji_dict, emoji_name: alias});
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | alias is a string; includes is substring search for search terms |  |

### #915 · zulip/zulip@36d2312680 · `web/src/filter.ts:218`

```
216:                     return false;
217:                 }
218:                 return operand_ids.every((id) => user_ids.includes(id));
219:             };
220:         }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | operand_ids x users in one DM conversation; DM groups are small |  |

### #916 · zulip/zulip@36d2312680 · `web/src/filter.ts:1131`

```
1129:         if (excluded_operators) {
1130:             filter_terms = this._terms.filter(
1131:                 (term) => !excluded_operators.includes(term.operator),
1132:             );
1133:         }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | excluded_operators is a short list of operator names |  |

### #919 · zulip/zulip@36d2312680 · `web/src/inbox_ui.ts:1367`

```
1365:     }
1366:     const search_words = keyword.toLowerCase().split(/\s+/);
1367:     return search_words.every((word) => text.includes(word));
1368: }
1369: 
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | text is a string; includes is substring search per search word |  |

### #922 · zulip/zulip@36d2312680 · `web/src/message_events.ts:789`

```
787:                     const old_topic_message_ids = old_topic_messages
788:                         .map((msg) => msg.id)
789:                         .filter((id) => !event.message_ids.includes(id));
790:                     const is_old_topic_empty_locally = old_topic_message_ids.length === 0;
791:                     const is_old_topic_empty_in_server =
```

| Proposed | Reason | Brad |
|---|---|---|
| true | event.message_ids (moved messages) x current message list; both grow with messages |  |

### #925 · zulip/zulip@36d2312680 · `web/src/narrow_banner.ts:133`

```
131:     // Gather information about each query word
132:     for (const query_word of query_words) {
133:         if (realm.stop_words.includes(query_word.toLowerCase())) {
134:             search_string_result.has_stop_word = true;
135:             search_string_result.query_words.push({
```

| Proposed | Reason | Brad |
|---|---|---|
| small | few query words x realm.stop_words (fixed stop-word list); outer loop is a handful |  |

### #930 · zulip/zulip@36d2312680 · `web/src/popover_menus.ts:313`

```
311:                         .elementsFromPoint(reference_rect.left, reference_rect.top)
312:                         .filter((element) =>
313:                             document
314:                                 .elementsFromPoint(reference_rect.right, reference_rect.bottom)
315:                                 .includes(element),
316:                         );
```

| Proposed | Reason | Brad |
|---|---|---|
| small | elementsFromPoint returns the DOM stack at a point (a few elements) |  |

### #932 · zulip/zulip@36d2312680 · `web/src/portico/team.ts:182`

```
180: 
181:         $(`#${CSS.escape(tab_name)}`).on("click", () => {
182:             if (!loaded_tabs.includes(tab_name)) {
183:                 const filtered_by_tab: ContributorData[] = contributors_list
184:                     .filter((c: Contributor) =>
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | includes runs once per click inside a handler, not per element; loaded_tabs is a few tab names |  |

### #933 · zulip/zulip@36d2312680 · `web/src/search_util.ts:21`

```
19:     */
20:     const val = opts.val.toLowerCase();
21:     return opts.search_terms.some((term) => val.includes(term));
22: }
23: 
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | val is a string; includes is substring search per search term |  |

### #936 · zulip/zulip@36d2312680 · `web/src/settings_components.ts:2002`

```
2000:             let can_edit_settings = can_edit_settings_with_metadata_access;
2001:             if (
2002:                 settings_config.stream_group_permission_settings_requiring_content_access.includes(
2003:                     setting_name,
2004:                 )
2005:             ) {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | fixed settings_config list of permission setting names |  |

### #937 · zulip/zulip@36d2312680 · `web/src/settings_notifications.ts:103`

```
101:                         settings_config.all_notifications(user_settings)
102:                             .disabled_notification_settings,
103:                     muted: muted_stream_ids.includes(stream.stream_id),
104:                     push_notifications_disabled: !realm.realm_push_notifications_enabled,
105:                 }),
```

| Proposed | Reason | Brad |
|---|---|---|
| true | muted_stream_ids x unmatched streams; both grow with channel count |  |

### #938 · zulip/zulip@36d2312680 · `web/src/stream_list_sort.ts:194`

```
192: 
193:     for (const stream_id of channels_to_check_topic_matches) {
194:         if (matching_stream_ids.includes(stream_id)) {
195:             continue;
196:         }
```

| Proposed | Reason | Brad |
|---|---|---|
| true | matching_stream_ids x all subscribed stream ids; both grow with channels |  |

### #945 · zulip/zulip@36d2312680 · `web/src/user_group_pill.ts:119`

```
117: ): UserGroup[] {
118:     const taken_group_ids = get_group_ids(pill_widget);
119:     items = items.filter((item) => !taken_group_ids.includes(item.id));
120:     return items;
121: }
```

| Proposed | Reason | Brad |
|---|---|---|
| true | taken group ids in pill widget x all user groups; size unknown, data-derived |  |

### #946 · zulip/zulip@36d2312680 · `web/src/user_pill.ts:162`

```
160: ): User[] {
161:     const taken_user_ids = get_user_ids(pill_widget);
162:     items = items.filter((item) => !taken_user_ids.includes(item.user_id));
163:     return items;
164: }
```

| Proposed | Reason | Brad |
|---|---|---|
| true | taken user ids (pills, can be large after group expansion) x realm users |  |

### #1168 · paperless-ngx/paperless-ngx@5f17b1a310 · `src-ui/src/app/components/common/input/drag-drop-select/drag-drop-select.component.ts:37`

```
35: 
36:   get unselectedItems(): { id: string; name: string }[] {
37:     return this.items.filter((i) => !this.selectedItems.includes(i))
38:   }
39: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | selectedItems x items = saved-view display fields (fixed fields + custom fields) |  |

### #1170 · paperless-ngx/paperless-ngx@5f17b1a310 · `src-ui/src/app/components/common/input/tags/tags.component.ts:212`

```
210:     if (this.suggestions && this.tags) {
211:       return this.suggestions
212:         .filter((id) => !this.value.includes(id))
213:         .map((id) => this.tags.find((tag) => tag.id == id))
214:     } else {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | this.value (a doc's selected tag ids) x tag suggestions for one document (few) |  |

### #1172 · paperless-ngx/paperless-ngx@5f17b1a310 · `src-ui/src/app/components/common/input/tags/tags.component.ts:233`

```
231:   onFilterDocuments() {
232:     this.filterDocuments.emit(
233:       this.tags.filter((t) => this.value.includes(t.id))
234:     )
235:   }
```

| Proposed | Reason | Brad |
|---|---|---|
| true | tags.filter over all tags (data, can be hundreds+) x value = selected tag ids; both data-derived, size unknown |  |

### #1173 · paperless-ngx/paperless-ngx@5f17b1a310 · `src-ui/src/app/components/common/permissions-select/permissions-select.component.ts:80`

```
78:       newInheritedPermissions.length !== this._inheritedPermissions.length ||
79:       newInheritedPermissions.some(
80:         (p) => !this._inheritedPermissions.includes(p)
81:       )
82: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | new vs old inherited permission codes; bounded by PermissionType x PermissionAction enums (fixed list) |  |

### #1174 · paperless-ngx/paperless-ngx@5f17b1a310 · `src-ui/src/app/components/common/permissions-select/permissions-select.component.ts:87`

```
85:       this.permissions = this.getSelectedPermissions(
86:         this.form.getRawValue()
87:       ).filter((p) => !this._inheritedPermissions.includes(p))
88:       this._inheritedPermissions = newInheritedPermissions
89:       this.applyCheckedState()
```

| Proposed | Reason | Brad |
|---|---|---|
| small | selected permission codes x inherited permission codes; both bounded by PermissionType x PermissionAction enums |  |

### #1175 · paperless-ngx/paperless-ngx@5f17b1a310 · `src-ui/src/app/components/common/permissions-select/permissions-select.component.ts:183`

```
181: 
182:       this.onChange(
183:         permissions.filter((p) => !this._inheritedPermissions.includes(p))
184:       )
185:     })
```

| Proposed | Reason | Brad |
|---|---|---|
| small | selected permissions x inherited permissions; bounded by the fixed permission enum product |  |

### #1176 · paperless-ngx/paperless-ngx@5f17b1a310 · `src-ui/src/app/components/common/permissions-select/permissions-select.component.ts:225`

```
223:         )
224:         .every((action) => {
225:           return this._inheritedPermissions.includes(
226:             this.permissionsService.getPermissionCode(
227:               PermissionAction[action],
228:               PermissionType[typeKey]
```

| Proposed | Reason | Brad |
|---|---|---|
| small | PermissionAction enum keys x inherited permission codes; enum-bounded |  |

### #1177 · paperless-ngx/paperless-ngx@5f17b1a310 · `src-ui/src/app/components/common/suggestions-dropdown/suggestions-dropdown.component.ts:154`

```
152: 
153:   private countUnapplied(suggested: number[], applied: number[]): number {
154:     return (suggested ?? []).filter((id) => !(applied ?? []).includes(id))
155:       .length
156:   }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | ML-suggested ids x applied ids on one document; suggestion lists are a handful (unsure) |  |

### #1179 · paperless-ngx/paperless-ngx@5f17b1a310 · `src-ui/src/app/components/document-detail/document-detail.component.ts:1110`

```
1108:         ? [SuggestionSource.ML, SuggestionSource.AI]
1109:         : [source]
1110:     ).filter((s) => !this.fetchedSuggestionSources().includes(s))
1111:     if (!sources.length) return
1112: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | sources has at most 2 elements (ML, AI) |  |

### #1180 · paperless-ngx/paperless-ngx@5f17b1a310 · `src-ui/src/app/components/document-list/bulk-editor/custom-fields-bulk-edit-dialog/custom-fields-bulk-edit-dialog.component.ts:73`

```
71:     this._fieldsToAddIds = ids
72:     this._fieldsToAdd = this.customFields.filter((field) =>
73:       this._fieldsToAddIds.includes(field.id)
74:     )
75:     this.initForm()
```

| Proposed | Reason | Brad |
|---|---|---|
| true | all custom fields (data) x selected field ids; size unknown, data-derived (unsure: likely tens) |  |

### #1183 · paperless-ngx/paperless-ngx@5f17b1a310 · `src-ui/src/app/services/document-list-view.service.ts:699`

```
697:         .subscribe((ids) => {
698:           for (let id of this.selected) {
699:             if (!ids.includes(id)) {
700:               this.selected.delete(id)
701:             }
```

| Proposed | Reason | Brad |
|---|---|---|
| true | selected document ids (Set, can be thousands) x ids from listAllFilteredIds (all matching docs); both grow with data |  |

### #1184 · paperless-ngx/paperless-ngx@5f17b1a310 · `src-ui/src/app/services/permissions.service.ts:88`

```
86:         object.permissions?.view.users.includes(this.currentUser.id) ||
87:         object.permissions?.view.groups.filter((g) =>
88:           this.currentUser.groups.includes(g)
89:         ).length > 0
90:       )
```

| Proposed | Reason | Brad |
|---|---|---|
| true | object's view.groups x currentUser.groups; size unknown, data-derived (unsure: usually a few groups) |  |

### #1185 · paperless-ngx/paperless-ngx@5f17b1a310 · `src-ui/src/app/services/permissions.service.ts:97`

```
95:         object.permissions?.change.users.includes(this.currentUser.id) ||
96:         object.permissions?.change.groups.filter((g) =>
97:           this.currentUser.groups.includes(g)
98:         ).length > 0
99:       )
```

| Proposed | Reason | Brad |
|---|---|---|
| true | object's change.groups x currentUser.groups; size unknown, data-derived (unsure: usually a few groups) |  |

### #1186 · paperless-ngx/paperless-ngx@5f17b1a310 · `src-ui/src/app/services/rest/document.service.ts:166`

```
164:     }
165:     this._sortFields = this._sortFields.filter(
166:       (field) => !excludes.includes(field.field)
167:     )
168:     this._sortFieldsFullText = [
```

| Proposed | Reason | Brad |
|---|---|---|
| small | excludes is a handful of fixed field names pushed by settings checks |  |

### #1188 · paperless-ngx/paperless-ngx@5f17b1a310 · `src-ui/src/app/services/rest/saved-view.service.ts:112`

```
110:       ? sorted
111:           .map((id) => sidebarViews.find((v) => v.id === id))
112:           .concat(sidebarViews.filter((v) => !sorted.includes(v.id)))
113:           .filter((v) => v)
114:       : [...sidebarViews]
```

| Proposed | Reason | Brad |
|---|---|---|
| true | saved views (user data) x sorted view ids from settings; size unknown, data-derived (unsure: typically tens) |  |

### #1190 · paperless-ngx/paperless-ngx@5f17b1a310 · `src-ui/src/app/services/rest/saved-view.service.ts:129`

```
127:       ? sorted
128:           .map((id) => dashboardViews.find((v) => v.id === id))
129:           .concat(dashboardViews.filter((v) => !sorted.includes(v.id)))
130:           .filter((v) => v)
131:       : [...dashboardViews]
```

| Proposed | Reason | Brad |
|---|---|---|
| true | dashboard saved views x sorted ids from settings; size unknown, data-derived (unsure: typically tens) |  |

### #1191 · paperless-ngx/paperless-ngx@5f17b1a310 · `src-ui/src/app/services/websocket-status.service.ts:234`

```
232:       (messageData.groups_can_view &&
233:         messageData.groups_can_view.some((groupId) =>
234:           user.groups?.includes(groupId)
235:         ))
236:     )
```

| Proposed | Reason | Brad |
|---|---|---|
| true | message groups_can_view x user.groups; size unknown, data-derived (unsure: usually few groups) |  |

### #1374 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/core/api/entity-data-subscription.ts:762`

```
760:         const tsKeys = this.aggTsValues.map(key => key.key);
761:         latestValuesKeys = latestValuesKeys.filter(latestKey => latestKey.type !== EntityKeyType.TIME_SERIES
762:           || !tsKeys.includes(latestKey.key));
763:       }
764:     }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | latest widget data keys x agg ts keys; both per-widget configured keys, a handful (unsure) |  |

### #1375 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/core/api/entity-data-subscription.ts:1021`

```
1019:           if (isUpdate && EntityKeyType[type] === EntityKeyType.TIME_SERIES) {
1020:             const keys: string[] = Object.keys(subscriptionData);
1021:             const latestTsKeys = this.latestValues.filter(key => key.type === EntityKeyType.TIME_SERIES && keys.includes(key.key));
1022:             if (latestTsKeys.length) {
1023:               const latestTsSubsciptionData: SubscriptionData = {};
```

| Proposed | Reason | Brad |
|---|---|---|
| small | widget latestValues keys x keys in one subscription update; per-widget configured keys (unsure) |  |

### #1376 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/core/api/entity-data-subscription.ts:1030`

```
1028:                 this.entityDataSubscriptionOptions.type === widgetType.timeseries, dataUpdatedCb);
1029:             }
1030:             const aggTsKeys = this.aggTsValues.filter(key => keys.includes(key.key));
1031:             if (!this.history && aggTsKeys.length && this.tsLatestDataAggregators && this.tsLatestDataAggregators[dataIndex]) {
1032:               const dataAggregator = this.tsLatestDataAggregators[dataIndex];
```

| Proposed | Reason | Brad |
|---|---|---|
| small | widget aggTsValues keys x keys in one subscription update; per-widget configured keys (unsure) |  |

### #1380 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/core/api/widget-subscription.ts:1180`

```
1178:       for (const datasource of datasources) {
1179:         if (datasource.entityAliasId) {
1180:           if (aliasIds.indexOf(datasource.entityAliasId) > -1) {
1181:             subscriptionsChanged = true;
1182:             break;
```

| Proposed | Reason | Brad |
|---|---|---|
| small | widget datasources x changed alias ids; dashboard config, a few per widget (unsure) |  |

### #1381 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/core/api/widget-subscription.ts:1200`

```
1198:       for (const datasource of datasources) {
1199:         if (datasource.filterId) {
1200:           if (filterIds.indexOf(datasource.filterId) > -1) {
1201:             subscriptionsChanged = true;
1202:             break;
```

| Proposed | Reason | Brad |
|---|---|---|
| small | widget datasources x changed filter ids; dashboard config, a few per widget (unsure) |  |

### #1393 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/core/http/entity.service.ts:932`

```
930:     let allAliasFilterTypes: Array<AliasFilterType> = Object.values(AliasFilterType);
931:     if (!authState.edgesSupportEnabled) {
932:       allAliasFilterTypes = allAliasFilterTypes.filter(aliasFilterType => !edgeAliasFilterTypes.includes(aliasFilterType));
933:     }
934:     if (!entityTypes || !entityTypes.length) {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | AliasFilterType enum values x edgeAliasFilterTypes constant list |  |

### #1394 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/core/http/entity.service.ts:983`

```
981:               if (relationFilter.entityTypes && relationFilter.entityTypes.length) {
982:                 for (const relationFilterEntityType of relationFilter.entityTypes) {
983:                   if (entityTypes.indexOf(relationFilterEntityType) > -1) {
984:                     match = true;
985:                     break;
```

| Proposed | Reason | Brad |
|---|---|---|
| small | relation filter entityTypes x requested entityTypes; both drawn from EntityType enum |  |

### #1395 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/core/services/menu.service.ts:84`

```
82:     if (this.currentMenuSections?.length) {
83:       this.currentMenuSections.filter(section => section.type === 'toggle' &&
84:         (openedMenuSections.includes(sectionPath(section)) || section.active)).forEach(
85:         section => section.opened = true
86:       );
```

| Proposed | Reason | Brad |
|---|---|---|
| small | fixed app menu sections x opened section paths |  |

### #1396 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/core/services/menu.service.ts:254`

```
252:   public menuLinksByIds(ids: string[]): Observable<Array<MenuSection>> {
253:     return this.availableMenuLinks$.pipe(
254:       map((links) => links.filter(link => ids.includes(link.id)).sort((a, b) => {
255:         const i1 = ids.indexOf(a.id);
256:         const i2 = ids.indexOf(b.id);
```

| Proposed | Reason | Brad |
|---|---|---|
| small | fixed app menu links x requested ids |  |

### #1398 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/core/services/resources.service.ts:57`

```
55:     }
56:     for (const comp of m.standaloneComponents) {
57:       if (!modulesWithComponents.standaloneComponents.includes(comp)) {
58:         modulesWithComponents.standaloneComponents.push(comp);
59:       }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | standalone components from widget modules deduped via includes on result; tens of components at most |  |

### #1407 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/converter/converter-autocomplete.component.ts:207`

```
205:             let entities: Array<Converter>;
206:             if (this.excludeEntityIds && this.excludeEntityIds.length) {
207:               entities = data.data.filter((entity) => this.excludeEntityIds.indexOf(entity.id.id) === -1);
208:             } else {
209:               entities = data.data;
```

| Proposed | Reason | Brad |
|---|---|---|
| small | converter page (limit 50 + excludes) x excludeEntityIds; page-capped |  |

### #1408 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/dashboard-page/layout/manage-dashboard-layouts-dialog.component.ts:214`

```
212: 
213:     this.allowBreakpointIds = Object.values(this.dashboardUtils.getListBreakpoint())
214:       .filter((item) => !this.selectedBreakpointIds.includes(item.id))
215:       .map(item => item.id);
216: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | dashboard layout breakpoints list (fixed few) x selected breakpoint ids |  |

### #1410 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/entity/entity-filter.component.ts:87`

```
85:     this.aliasFilterTypes = this.entityService.getAliasFilterTypesByEntityTypes(this.allowedEntityTypes);
86:     this.entityGroupTypes = entityGroupTypes.filter((entityType) =>
87:       this.allowedEntityTypes ? this.allowedEntityTypes.indexOf(entityType) > - 1 : true
88:     );
89: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | entityGroupTypes constant x allowedEntityTypes (EntityType enum) |  |

### #1411 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/event/event-table-config.ts:113`

```
111: 
112:     if (disabledEventTypes && disabledEventTypes.length) {
113:       this.eventTypes = this.eventTypes.filter(type => disabledEventTypes.indexOf(type) === -1);
114:     }
115: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | EventType enum values x disabledEventTypes |  |

### #1413 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/integration/mqtt-topic-filters/mqtt-topic-filters.component.ts:74`

```
72:         const excludeQos = change.currentValue;
73:         if (excludeQos?.length) {
74:           this.mqttQosTypes = Object.values(MqttQos).filter((v): v is MqttQos  => !excludeQos.includes(v) && isNumber(v));
75:         } else {
76:           this.mqttQosTypes = Object.values(MqttQos).filter((v): v is MqttQos => isNumber(v));
```

| Proposed | Reason | Brad |
|---|---|---|
| small | MqttQos enum (3 values) x excludeQos |  |

### #1421 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/profile/device/lwm2m/lwm2m-attributes-key-list.component.ts:181`

```
179:   private getFirstUnusedAttributesName(): AttributeName {
180:     for (const attributeName of this.attributeNames) {
181:       if (this.usedAttributesName.indexOf(attributeName) === -1) {
182:         return attributeName;
183:       }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | LwM2M attributeNames enum x used attribute names |  |

### #1424 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/profile/device/snmp/snmp-device-profile-communication-config.component.ts:141`

```
139:   private getFirstUnusedSeverity(): SnmpSpecType {
140:     for (const type of Object.values(SnmpSpecType)) {
141:       if (this.usedSpecType.indexOf(type) === -1) {
142:         return type;
143:       }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | SnmpSpecType enum values x used spec types |  |

### #1426 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/rule-node/analytics/alarms-count-mapping-dialog.component.ts:171`

```
169:   private getAlarmStatusList(): Array<AlarmStatus> {
170:     return this.alarmStatusList.filter((listItem) => {
171:       return this.alarmsCountMappingFormGroup.get('statusList').value.indexOf(listItem) === -1;
172:     });
173:   }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | AlarmStatus enum list x selected statuses |  |

### #1427 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/rule-node/analytics/alarms-count-mapping-dialog.component.ts:224`

```
222:   private getAlarmSeverityList(): Array<AlarmSeverity> {
223:     return this.alarmSeverityList.filter((listItem) => {
224:       return this.alarmsCountMappingFormGroup.get('severityList').value.indexOf(listItem) === -1;
225:     });
226:   }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | AlarmSeverity enum list x selected severities |  |

### #1430 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/vc/auto-commit-settings.component.ts:154`

```
152:       this.autoCommitSettingsForm.get('entityTypes').value || [];
153:     const usedEntityTypes = value.map(val => val.entityType).filter(val => val);
154:     res = res.filter(entityType => !usedEntityTypes.includes(entityType) || entityType === currentEntityType);
155:     return res;
156:   }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | exportableEntityTypes constant x used entity types in form |  |

### #1431 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/vc/entity-types-version-create.component.ts:262`

```
260:       this.entityTypesVersionCreateFormGroup.get('entityTypes').value || [];
261:     const usedEntityTypes = value.map(val => val.entityType).filter(val => val);
262:     res = res.filter(entityType => !usedEntityTypes.includes(entityType) || entityType === currentEntityType);
263:     return res;
264:   }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | exportableEntityTypes constant x used entity types in form |  |

### #1432 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/vc/entity-types-version-load.component.ts:222`

```
220:       this.entityTypesVersionLoadFormGroup.get('entityTypes').value || [];
221:     const usedEntityTypes = value.map(val => val.entityType).filter(val => val);
222:     res = res.filter(entityType => !usedEntityTypes.includes(entityType) || entityType === currentEntityType);
223:     return res;
224:   }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | exportableEntityTypes constant x used entity types in form |  |

### #1434 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/action/manage-widget-actions.component.models.ts:75`

```
73:     for (const importedAction of importedActions) {
74:       let targetActions = targetMap[actionSourceId];
75:       if (!allowedActionTypes.includes(importedAction.type) ||
76:           (!actionSource.multiple && targetActions?.length)) {
77:         result.skipped++;
```

| Proposed | Reason | Brad |
|---|---|---|
| small | imported widget actions x allowedActionTypes (WidgetActionType enum-sized list) |  |

### #1435 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/config/datasources.component.ts:288`

```
286:         if (!valid) {
287:           for (const emptyDatasource of emptyDatasources) {
288:             const i = datasources.indexOf(emptyDatasource);
289:             this.datasourceError[i] = 'At least one data key should be specified';
290:           }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | empty datasources x widget datasources (indexOf on same widget's few datasources) |  |

### #1436 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/alarm/alarms-table-widget.component.ts:602`

```
600:         title: column.title,
601:         def: column.def,
602:         display: this.displayedColumns.indexOf(column.def) > -1,
603:         selectable: this.columnSelectionAvailability[column.def]
604:       }));
```

| Proposed | Reason | Brad |
|---|---|---|
| small | table column defs x displayed column defs; a handful of columns |  |

### #1438 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/alarm/alarms-table-widget.component.ts:1492`

```
1490:       if (this.selection.hasValue()) {
1491:         const alarmIds = alarms.map((alarm) => alarm.id.id);
1492:         const toRemove = this.selection.selected.filter(alarm => alarmIds.indexOf(alarm.id.id) === -1);
1493:         this.selection.deselect(...toRemove);
1494:         if (this.selection.isEmpty()) {
```

| Proposed | Reason | Brad |
|---|---|---|
| true | selected alarms x alarmIds of loaded alarms (page up to 1024 rows); both data-derived |  |

### #1440 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/cards/notification-type-filter-panel.component.ts:57`

```
55:       map(value => {
56:         this.searchText = value;
57:         return this.notificationTypes.filter(type => !this.selectedNotificationTypes.includes(type))
58:           .filter(type => value ? type.toUpperCase().startsWith(value.toUpperCase()) : true);
59:       })
```

| Proposed | Reason | Brad |
|---|---|---|
| small | NotificationType enum list x selected notification types |  |

### #1443 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/chart/time-series-chart-state.models.ts:39`

```
37:         this.rangeStates.push(state);
38:       }
39:       if (!ticks.includes(state.value)) {
40:         ticks.push(state.value);
41:         const label = utils.customTranslation(state.label, state.label);
```

| Proposed | Reason | Brad |
|---|---|---|
| small | chart state settings x ticks; a few user-configured states |  |

### #1444 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/chart/time-series-chart.models.ts:1284`

```
1282:       item.barRenderContext.noAggregation = noAggregation;
1283:       item.barRenderContext.barsCount = barsCount;
1284:       item.barRenderContext.barIndex = stack ? barGroups.indexOf(item.yAxisIndex) : barDataItems.indexOf(item);
1285:       if (stack) {
1286:         const stackItems = enabledDataItems.filter(d => d.yAxisIndex === item.yAxisIndex);
```

| Proposed | Reason | Brad |
|---|---|---|
| small | chart series items x bar groups / bar items; few series per chart |  |

### #1445 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/chart/time-series-chart.models.ts:1288`

```
1286:         const stackItems = enabledDataItems.filter(d => d.yAxisIndex === item.yAxisIndex);
1287:         item.barRenderContext.currentStackItems = stackItems;
1288:         item.barRenderContext.barStackIndex = stackItems.indexOf(item);
1289:       }
1290:     }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | chart series items x stack items; few series per chart |  |

### #1447 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/chart/time-series-chart.models.ts:1563`

```
1561:       }
1562:     }
1563:     const toRemove = existingYAxisKeys.filter(k => foundYAxisKeys.indexOf(k) === -1);
1564:     for (const key of toRemove) {
1565:       const index = latestKeys.indexOf(key);
```

| Proposed | Reason | Brad |
|---|---|---|
| small | existing y-axis keys x found y-axis keys; a few axes |  |

### #1448 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/chart/time-series-chart.models.ts:1565`

```
1563:     const toRemove = existingYAxisKeys.filter(k => foundYAxisKeys.indexOf(k) === -1);
1564:     for (const key of toRemove) {
1565:       const index = latestKeys.indexOf(key);
1566:       if (index > -1) {
1567:         latestKeys.splice(index, 1);
```

| Proposed | Reason | Brad |
|---|---|---|
| small | y-axis keys to remove x widget latestKeys; few keys |  |

### #1458 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/entity/entities-table-widget.component.ts:584`

```
582:       title: column.title,
583:       def: column.def,
584:       display: this.displayedColumns.indexOf(column.def) > -1,
585:       selectable: this.columnSelectionAvailability[column.def]
586:     }));
```

| Proposed | Reason | Brad |
|---|---|---|
| small | table column defs x displayed column defs; a handful of columns |  |

### #1467 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/scada/scada-symbol.models.ts:244`

```
242:     tagsMatch = tbTagRegex.exec(svgContent);
243:   }
244:   return tags.filter((v, i, arr) => arr.indexOf(v) === i);
245: };
246: 
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | dedup filter arr.indexOf(v)===i on the same tags array, not a second collection |  |

### #1471 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/settings/common/action/location-keys-table.component.ts:131`

```
129:     const usedArguments: LocationKey[] = this.keysFormArray().getRawValue().map(mapping => mapping.argument);
130:     const currentArgument: LocationKey = keyControl.get('argument').value;
131:     return this.availableKeys.filter(argument => argument === currentArgument || !usedArguments.includes(argument));
132:   }
133: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | LocationKey available keys (enum) x used arguments |  |

### #1472 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/settings/common/action/location-keys-table.component.ts:140`

```
138:   addKey(): void {
139:     const usedArguments: LocationKey[] = this.keysFormArray().getRawValue().map(mapping => mapping.argument);
140:     const argument = this.availableKeys.find(available => !usedArguments.includes(available));
141:     if (argument) {
142:       this.keysFormArray().push(this.keyControl(locationKeyMapping(argument)));
```

| Proposed | Reason | Brad |
|---|---|---|
| small | LocationKey available keys (enum) x used arguments |  |

### #1473 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/settings/common/action/location-keys-table.component.ts:157`

```
155: 
156:   private prepareKeysFormArray(value: LocationKeyMapping[] | undefined): FormArray {
157:     const mappings = (value || []).filter(mapping => this.availableKeys.includes(mapping?.argument));
158:     mandatoryLocationKeys.filter(argument => !mappings.some(mapping => mapping.argument === argument))
159:       .forEach((argument) => mappings.splice(mandatoryLocationKeys.indexOf(argument), 0,
```

| Proposed | Reason | Brad |
|---|---|---|
| small | location key mappings x availableKeys (LocationKey enum) |  |

### #1475 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/settings/common/action/location-keys-table.component.ts:159`

```
157:     const mappings = (value || []).filter(mapping => this.availableKeys.includes(mapping?.argument));
158:     mandatoryLocationKeys.filter(argument => !mappings.some(mapping => mapping.argument === argument))
159:       .forEach((argument) => mappings.splice(mandatoryLocationKeys.indexOf(argument), 0,
160:         locationKeyMapping(argument)));
161:     return this.fb.array(mappings.map(mapping => this.keyControl(mapping)), [this.uniqueKeyNamesValidator]);
```

| Proposed | Reason | Brad |
|---|---|---|
| small | mandatoryLocationKeys constant indexOf per missing mandatory key |  |

### #1476 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/settings/common/action/mobile-action-editor.component.ts:404`

```
402:       this.fb.control(action?.targetEntity ?? {type: LocationTargetSource.CURRENT_ENTITY}, [])
403:     );
404:     const keys = action?.keys?.filter(mapping => availableKeys.includes(mapping?.argument)) ?? [];
405:     this.mobileActionTypeFormGroup.addControl(
406:       'keys',
```

| Proposed | Reason | Brad |
|---|---|---|
| small | action key mappings x availableKeys (LocationKey enum) |  |

### #1477 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/settings/common/chart/time-series-chart-thresholds-panel.component.ts:207`

```
205:         }
206:       }
207:       const toRemove = existingThresholdKeys.filter(k => foundThresholdKeys.indexOf(k) === -1);
208:       for (const key of toRemove) {
209:         const index = latestKeys.indexOf(key);
```

| Proposed | Reason | Brad |
|---|---|---|
| small | existing threshold keys x found threshold keys; a few thresholds |  |

### #1478 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/settings/common/chart/time-series-chart-thresholds-panel.component.ts:209`

```
207:       const toRemove = existingThresholdKeys.filter(k => foundThresholdKeys.indexOf(k) === -1);
208:       for (const key of toRemove) {
209:         const index = latestKeys.indexOf(key);
210:         if (index > -1) {
211:           latestKeys.splice(index, 1);
```

| Proposed | Reason | Brad |
|---|---|---|
| small | threshold keys to remove x widget latestKeys; few keys |  |

### #1480 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/settings/common/dynamic-form/dynamic-form.component.ts:201`

```
199:         if (property.type !== FormPropertyType.htmlSection) {
200:           if (property.disableOnProperty) {
201:             if (!this.validatorTriggers.includes(property.disableOnProperty)) {
202:               this.validatorTriggers.push(property.disableOnProperty);
203:             }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | form properties x validatorTriggers built from them; settings-form schema, tens at most |  |

### #1486 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/pages/admin/mail-templates.component.ts:85`

```
83:     }
84:     this.mailTemplatesSettings = this.route.snapshot.data.mailTemplatesSettings;
85:     this.mailTemplateTypes = Object.keys(MailTemplate).filter(type => Object.keys(this.mailTemplatesSettings).includes(type));
86:     if (this.isTenantAdmin()) {
87:       this.useSystemMailSettings = isDefinedAndNotNull(this.mailTemplatesSettings.useSystemMailSettings) ? this.mailTemplatesSettings.useSystemMailSettings : true;
```

| Proposed | Reason | Brad |
|---|---|---|
| small | MailTemplate enum keys x settings keys |  |

### #1487 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/pages/agent/dialog/agent-profile-preset-dialog.component.ts:131`

```
129: 
130:   tileDisabled(tile: PresetTile): boolean {
131:     return this.templatesState === 'loaded' && tile.appTypes.some(t => this.missingTypes.includes(t));
132:   }
133: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | tile appTypes x missingTypes; small app-type enum |  |

### #1492 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/pages/mobile/bundes/sefl-registration/mobile-registration-fields-panel.component.ts:117`

```
115:       selectedFields.push(item.id);
116:     });
117:     this.allowRegistrationFields = allFields.filter(item => !selectedFields.includes(item))
118:   }
119: }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | SignUpFieldMap keys (fixed) x selected registration fields |  |

### #1499 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/pages/scada-symbol/scada-symbol-editor.models.ts:262`

```
260:           let overlappingGroup: ScadaSymbolElement[];
261:           for (const list of overlappingGroups) {
262:             if (list.includes(other) || list.includes(el)) {
263:               overlappingGroup = list;
264:               break;
```

| Proposed | Reason | Brad |
|---|---|---|
| true | SCADA SVG elements (user SVG, size unknown) in O(n^2) pair loop x overlapping group lists (unsure) |  |

### #1500 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/pages/scada-symbol/scada-symbol-editor.models.ts:271`

```
269:             overlappingGroups.push(overlappingGroup);
270:           } else {
271:             if (!overlappingGroup.includes(el)) {
272:               overlappingGroup.push(el);
273:             } else if (!overlappingGroup.includes(other)){
```

| Proposed | Reason | Brad |
|---|---|---|
| true | overlapping group membership check inside elements x elements loop; user SVG size unknown (unsure) |  |

### #1501 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/pages/scada-symbol/scada-symbol-editor.models.ts:273`

```
271:             if (!overlappingGroup.includes(el)) {
272:               overlappingGroup.push(el);
273:             } else if (!overlappingGroup.includes(other)){
274:               overlappingGroup.push(other);
275:             }
```

| Proposed | Reason | Brad |
|---|---|---|
| true | overlapping group membership check inside elements x elements loop; user SVG size unknown (unsure) |  |

### #1502 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/pages/scada-symbol/scada-symbol-editor.models.ts:401`

```
399:     .filter(e => e.hasTag())
400:     .map(e => e.tag)
401:     .filter((v, i, a) => a.indexOf(v) === i)
402:     .sort();
403:     this.callbacks.tagsUpdated(this.tags);
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | dedup filter a.indexOf(v)===i on the same tags array, not a second collection |  |

### #1503 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/pages/task-manager/task-manager-table-config.resolver.ts:371`

```
369:   private cancelTasks($event: Event, tasks: Job[]): void {
370:     $event?.stopPropagation();
371:     const workingTasks = tasks.filter(job => workingTask.includes(job.status));
372:     let title = '';
373:     let content = '';
```

| Proposed | Reason | Brad |
|---|---|---|
| small | selected jobs x workingTask constant status list |  |

### #1504 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/pages/task-manager/task-manager-table-config.resolver.ts:421`

```
419:   private deleteTasks($event: Event, tasks: Job[]): void {
420:     $event?.stopPropagation();
421:     const finishTasks = tasks.filter(job => !workingTask.includes(job.status));
422:     let title = '';
423:     let content = '';
```

| Proposed | Reason | Brad |
|---|---|---|
| small | selected jobs x workingTask constant status list |  |

### #1505 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/pages/widget/widget-type-autocomplete.component.ts:181`

```
179:       switchMap((data) => {
180:         if (this.excludeWidgetTypeIds?.length) {
181:           const filtered = data.data.filter(w => !this.excludeWidgetTypeIds.includes(w.id.id));
182:           result = result.concat(filtered);
183:         } else {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | widget types page (pageSize 10) x excludeWidgetTypeIds; page-capped |  |

### #1506 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/shared/components/directives/component-outlet.directive.ts:83`

```
81:         if (prevCtxKeys.length === currCtxKeys.length) {
82:           for (const propName of currCtxKeys) {
83:             if (prevCtxKeys.indexOf(propName) === -1) {
84:               return true;
85:             }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | current context keys x previous context keys of a template context object |  |

### #1507 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/shared/components/directives/sring-template-outlet.directive.ts:76`

```
74:         if (prevCtxKeys.length === currCtxKeys.length) {
75:           for (const propName of currCtxKeys) {
76:             if (prevCtxKeys.indexOf(propName) === -1) {
77:               return true;
78:             }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | current context keys x previous context keys of a template context object |  |

### #1508 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/shared/components/group/entity-group-list.component.ts:287`

```
285:         }
286:         if (this.modelValue) {
287:           data = data.filter(group => !this.modelValue.includes(group.id.id));
288:         }
289:         return data;
```

| Proposed | Reason | Brad |
|---|---|---|
| small | entity groups page (pageSize 50) x selected group ids; page-capped |  |

### #1513 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/shared/components/mqtt-version-select.component.ts:53`

```
51:         const excludeVersions = change.currentValue;
52:         if (excludeVersions?.length) {
53:           this.mqttVersions = Object.values(MqttVersion).filter(v => !excludeVersions.includes(v));
54:         } else {
55:           this.mqttVersions = Object.values(MqttVersion);
```

| Proposed | Reason | Brad |
|---|---|---|
| small | MqttVersion enum x excludeVersions |  |

### #1514 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/shared/components/time/interval-options-config-panel.component.ts:92`

```
90:         ? this.aggIntervalsConfig[interval.value]
91:         : null;
92:       const intervalEnabled = this.allowedIntervals?.length ? this.allowedIntervals.includes(interval.value) : true;
93:       const intervalControl = this.fb.group({
94:         name: [this.translate.instant(interval.name, interval.translateParams)],
```

| Proposed | Reason | Brad |
|---|---|---|
| small | fixed interval options list x allowedIntervals |  |

### #1515 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/shared/components/widgets-bundle-select.component.ts:185`

```
183:       widgetsBundlesObservable = widgetsBundlesObservable.pipe(
184:         map((widgetBundles) =>
185:           widgetBundles.filter(w => !this.excludeBundleIds.includes(w.id.id)))
186:       );
187:     }
```

| Proposed | Reason | Brad |
|---|---|---|
| true | all widget bundles (tenant/system data) x excludeBundleIds; size unknown, data-derived |  |

### #1516 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/shared/import-export/import-export.service.ts:1283`

```
1281:       return !Array.isArray(actions) || actions.some(action => !isObject(action)
1282:         || !isNotEmptyStr(action.name)
1283:         || !Object.values(WidgetActionType).includes(action.type));
1284:     });
1285:   }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | imported actions x Object.values(WidgetActionType) enum |  |

### #1517 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/shared/legacy/json-form-utils.ts:186`

```
184:         path.push(k);
185:         if (options.ignore[ObjectPath.stringify(path)] !== true) {
186:           const required = schema.required && schema.required.indexOf(k) !== -1;
187: 
188:           const def = defaultFormDefinition(k, schema.properties[k], {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | JSON schema properties x schema.required; settings schema, tens at most |  |

### #1518 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/shared/legacy/json-form-utils.ts:279`

```
277:       if (schema.properties.hasOwnProperty(k)) {
278:         if (ignore[k] !== true) {
279:           const required = schema.required && schema.required.indexOf(k) !== -1;
280:           const def = defaultFormDefinition(k, schema.properties[k], {
281:             path: [k], // Path to this property in bracket notation.
```

| Proposed | Reason | Brad |
|---|---|---|
| small | JSON schema properties x schema.required; settings schema, tens at most |  |

### #1536 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/shared/models/entity-group.models.ts:323`

```
321:     if (typeColumns.length) {
322:       typeColumns = typeColumns.filter((c, pos, columnsArray) =>
323:         columnsArray.map(mapCol => mapCol.property).indexOf(c.property) === pos);
324:       const entityKeyType = groupColumnTypeToEntityKeyType(type);
325:       result[entityKeyType] = typeColumns;
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | dedup filter on the same typeColumns array via map().indexOf(pos), not a second collection |  |

### #1537 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/shared/models/material.models.ts:522`

```
520:   const value = materialColorPalette[key];
521:   for (const label of Object.keys(value)) {
522:     if (colorSpectrum.indexOf(label) > -1) {
523:       const colorValue = value[label];
524:       const color = tinycolor(colorValue);
```

| Proposed | Reason | Brad |
|---|---|---|
| small | palette labels x colorSpectrum constant (10 values); module-init only |  |

### #1538 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/shared/models/mobile-app.models.ts:181`

```
179: export const getDefaultMobileMenuItem = (): DefaultMobilePage[] => {
180:   return deepClone(defaultMobileMenu).map(item => ({
181:     visible: !hideDefaultMenuItems.includes(item),
182:     type: MobilePageType.DEFAULT,
183:     id: item
```

| Proposed | Reason | Brad |
|---|---|---|
| small | defaultMobileMenu constant x hideDefaultMenuItems constant (3 values) |  |

### #1539 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/shared/models/mobile-app.models.ts:199`

```
197:     if (!mergedPages.some(page => isDefaultMobileMenuItem(page) && page.id === defaultPage.id)) {
198:       const nextDefaultPageIndex = mergedPages.findIndex(page =>
199:         isDefaultMobileMenuItem(page) && defaultMobileMenu.indexOf(page.id) > defaultIndex
200:       );
201:       mergedPages.splice(nextDefaultPageIndex === -1 ? mergedPages.length : nextDefaultPageIndex, 0, {...defaultPage, visible: false});
```

| Proposed | Reason | Brad |
|---|---|---|
| small | merged mobile pages x defaultMobileMenu constant list |  |

### #1541 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/shared/models/time/time.models.ts:1338`

```
1336: 
1337: export const intervalValuesToTimeIntervals = (intervalValues: Array<Interval>): Array<TimeInterval> => {
1338:   return defaultTimeIntervals.filter(interval => intervalValues.includes(interval.value));
1339: }
1340: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | defaultTimeIntervals constant x intervalValues |  |

### #1542 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/shared/models/widget/maps/map-model.definition.ts:91`

```
89:   hasTimewindow(widget: Widget): boolean {
90:     const settings: BaseMapSettings = widget.config.settings as BaseMapSettings;
91:     const timeSeriesDataLayerTypes = mapDataLayerTypes.filter(t => !latestMapDataLayerTypes.includes(t));
92:     if (timeSeriesDataLayerTypes.some(layerType => settings[layerType]?.length)) {
93:       return true;
```

| Proposed | Reason | Brad |
|---|---|---|
| small | mapDataLayerTypes constant x latestMapDataLayerTypes constant |  |

### #1567 · prometheus/prometheus@a83f7158e7 · `web/ui/mantine-ui/src/components/StateMultiSelect.tsx:123`

```
121:                 value={value}
122:                 key={value}
123:                 active={values.includes(value)}
124:               >
125:                 <Group gap="sm">
```

| Proposed | Reason | Brad |
|---|---|---|
| small | alert/rule state options (a few) x selected values |  |

### #1568 · prometheus/prometheus@a83f7158e7 · `web/ui/mantine-ui/src/components/StateMultiSelect.tsx:126`

```
124:               >
125:                 <Group gap="sm">
126:                   {values.includes(value) ? (
127:                     <CheckIcon size={12} color="gray" />
128:                   ) : null}
```

| Proposed | Reason | Brad |
|---|---|---|
| small | alert/rule state options (a few) x selected values |  |

### #1569 · prometheus/prometheus@a83f7158e7 · `web/ui/mantine-ui/src/pages/AlertsPage.tsx:132`

```
130:         ? group.rules
131:         : kvSearch.filter(search, group.rules).map((value) => value.original)
132:     ).filter((r) => stateFilter.length === 0 || stateFilter.includes(r.state));
133: 
134:     pageData.groups.push({
```

| Proposed | Reason | Brad |
|---|---|---|
| small | alerting rules x stateFilter (few alert states) |  |

### #1570 · prometheus/prometheus@a83f7158e7 · `web/ui/mantine-ui/src/pages/RulesPage.tsx:75`

```
73:       : kvSearch.filter(search, group.rules).map((value) => value.original)
74:     ).filter(
75:       (r) => healthFilter.length === 0 || healthFilter.includes(r.health)
76:     ),
77:   }));
```

| Proposed | Reason | Brad |
|---|---|---|
| small | rules x healthFilter (few health values) |  |

### #1571 · prometheus/prometheus@a83f7158e7 · `web/ui/mantine-ui/src/pages/service-discovery/ServiceDiscoveryPoolsList.tsx:246`

```
244:         variant="separated"
245:         keepMounted={false}
246:         value={allPoolNames.filter((p) => !collapsedPools.includes(p))}
247:         onChange={(value) =>
248:           dispatch(
```

| Proposed | Reason | Brad |
|---|---|---|
| true | all scrape pool names (can be hundreds+) x collapsedPools (user-collapsed, can approach all pools) |  |

### #1572 · prometheus/prometheus@a83f7158e7 · `web/ui/mantine-ui/src/pages/service-discovery/ServiceDiscoveryPoolsList.tsx:249`

```
247:         onChange={(value) =>
248:           dispatch(
249:             setCollapsedPools(allPoolNames.filter((p) => !value.includes(p)))
250:           )
251:         }
```

| Proposed | Reason | Brad |
|---|---|---|
| true | all scrape pool names x accordion open values; both scale with pool count |  |

### #1573 · prometheus/prometheus@a83f7158e7 · `web/ui/mantine-ui/src/pages/targets/ScrapePoolsList.tsx:120`

```
118:   ).filter(
119:     (target) =>
120:       healthFilter.length === 0 || healthFilter.includes(target.health)
121:   );
122: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | targets x healthFilter (few health values) |  |

### #1574 · prometheus/prometheus@a83f7158e7 · `web/ui/mantine-ui/src/pages/targets/ScrapePoolsList.tsx:217`

```
215:           variant="separated"
216:           keepMounted={false}
217:           value={allPoolNames.filter((p) => !collapsedPools.includes(p))}
218:           onChange={(value) =>
219:             dispatch(
```

| Proposed | Reason | Brad |
|---|---|---|
| true | all scrape pool names (can be hundreds+) x collapsedPools (user-collapsed, can approach all pools) |  |

### #1575 · prometheus/prometheus@a83f7158e7 · `web/ui/mantine-ui/src/pages/targets/ScrapePoolsList.tsx:220`

```
218:           onChange={(value) =>
219:             dispatch(
220:               setCollapsedPools(allPoolNames.filter((p) => !value.includes(p)))
221:             )
222:           }
```

| Proposed | Reason | Brad |
|---|---|---|
| true | all scrape pool names x accordion open values; both scale with pool count |  |

### #1576 · prometheus/prometheus@a83f7158e7 · `web/ui/mantine-ui/src/promql/binOp.ts:123`

```
121:     fnv1a(
122:       Object.keys(lset)
123:         .filter((ln) => !names.includes(ln) && ln !== "__name__")
124:         .map((ln) => lset[ln])
125:     );
```

| Proposed | Reason | Brad |
|---|---|---|
| small | series label names x on/ignoring label list (a few names in a PromQL clause) |  |

### #1662 · go-gitea/gitea@85211296dd · `tools/ci-tools.ts:153`

```
151: 
152:   const stale = new Set([...removableLabels, ...labelsForPrTitle(env.PR_TITLE_BEFORE ?? '')]);
153:   const toAdd = desired.filter((name) => !current.includes(name));
154:   const toRemove = current.filter((name) => stale.has(name) && !desired.includes(name));
155: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | desired PR labels (derived from title, few) x current PR labels (few) |  |

### #1663 · go-gitea/gitea@85211296dd · `tools/ci-tools.ts:154`

```
152:   const stale = new Set([...removableLabels, ...labelsForPrTitle(env.PR_TITLE_BEFORE ?? '')]);
153:   const toAdd = desired.filter((name) => !current.includes(name));
154:   const toRemove = current.filter((name) => stale.has(name) && !desired.includes(name));
155: 
156:   if (toAdd.length) {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | current PR labels (few) x desired labels (few) |  |

### #1668 · go-gitea/gitea@85211296dd · `web_src/js/components/ProjectWorkflowStore.ts:169`

```
167:       const sourceTitle = source_column_id && columnTitle(source_column_id);
168:       const targetTitle = target_column_id && columnTitle(target_column_id);
169:       const labelNames = store.labels.filter((l) => label_ids?.includes(l.id)).map((l) => l.name);
170:       const parts = [
171:         issue_type === 'issue' && props.locale.issuesOnly,
```

| Proposed | Reason | Brad |
|---|---|---|
| true | repo labels (data, size unknown) x workflow filter label_ids; data-derived (unsure: label_ids likely few) |  |

### #1679 · go-gitea/gitea@85211296dd · `web_src/js/features/repo-issue-sidebar-combolist.ts:104`

```
102:     if (this.updateAlgo === 'diff') {
103:       for (const value of this.initialValues) {
104:         if (!changedValues.includes(value)) {
105:           lastResp = await POST(this.updateUrl, {data: new URLSearchParams({action: 'detach', id: value})});
106:           if (!lastResp.ok) return lastResp;
```

| Proposed | Reason | Brad |
|---|---|---|
| small | issue sidebar initial vs changed selections on one issue; each iteration awaits a POST (unsure) |  |

### #1681 · go-gitea/gitea@85211296dd · `web_src/js/features/repo-issue-sidebar-combolist.ts:110`

```
108:       }
109:       for (const value of changedValues) {
110:         if (!this.initialValues.includes(value)) {
111:           lastResp = await POST(this.updateUrl, {data: new URLSearchParams({action: 'attach', id: value})});
112:           if (!lastResp.ok) return lastResp;
```

| Proposed | Reason | Brad |
|---|---|---|
| small | issue sidebar changed vs initial selections on one issue; each iteration awaits a POST (unsure) |  |

### #1687 · go-gitea/gitea@85211296dd · `web_src/js/modules/diff-file.ts:116`

```
114:     .filter(Boolean)
115:     .map((ext) => ext === urlValueNoExtension ? '' : ext)
116:     .filter((ext) => knownExtensions.includes(ext));
117:   return extensions.length === knownExtensions.length ? 'all' : extensions;
118: }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | URL-selected extensions x knownExtensions in one diff; tens at most (unsure) |  |

### #1702 · go-gitea/gitea@85211296dd · `web_src/js/webcomponents/overflow-menu.ts:147`

```
145:     // remove aria role from items that moved from popup to menu
146:     for (const item of menuItems) {
147:       if (!this.overflowItems.includes(item)) {
148:         item.removeAttribute('role');
149:       }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | overflow menu DOM items x overflowed items; tens of menu entries |  |

### #1723 · traefik/traefik@f1f227eda7 · `webui/src/components/middlewares/MiddlewareDetail.tsx:23`

```
21:   const propsToRemove = ['name', 'plugin', 'status', 'type', 'provider', 'error', 'usedBy', 'routers']
22: 
23:   return Object.keys(middleware).filter((propName) => !propsToRemove.includes(propName))
24: }
25: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | middleware object keys x fixed 8-name propsToRemove list |  |


## `bpm-perf-java-contains-in-loop`

### #1249 · thingsboard/thingsboard@7a53801216 · `application/src/main/java/org/thingsboard/server/actors/calculatedField/CalculatedFieldEntityMessageProcessor.java:673`

```
671:             }
672:             argNames.forEach(argName -> {
673:                 if (geofencingArgNames.contains(argName)) {
674:                     arguments.put(argName, new GeofencingArgumentEntry(entityId, item));
675:                 } else {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | arg names x geofencingArgNames list; calculated-field args are a few |  |

### #1250 · thingsboard/thingsboard@7a53801216 · `application/src/main/java/org/thingsboard/server/actors/calculatedField/CalculatedFieldEntityMessageProcessor.java:720`

```
718:             }
719:             argNames.forEach(argName -> {
720:                 if (geofencingArgNames.contains(argName)) {
721:                     arguments.put(argName, new GeofencingArgumentEntry());
722:                 } else {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | arg names x geofencingArgNames list; calculated-field args are a few |  |

### #1251 · thingsboard/thingsboard@7a53801216 · `application/src/main/java/org/thingsboard/server/actors/calculatedField/CalculatedFieldEntityMessageProcessor.java:745`

```
743:     private Map<String, ArgumentEntry> mapToArgumentsWithFetchedValue(CalculatedFieldCtx ctx, EntityId entityId, List<String> removedTelemetryKeys) {
744:         Map<String, Argument> deletedArguments = ctx.getArguments().entrySet().stream()
745:                 .filter(entry -> removedTelemetryKeys.contains(entry.getValue().getRefEntityKey().getKey()))
746:                 .collect(Collectors.toMap(Map.Entry::getKey, Map.Entry::getValue));
747: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | CF arguments x removedTelemetryKeys list; a few args/keys |  |

### #1254 · thingsboard/thingsboard@7a53801216 · `application/src/main/java/org/thingsboard/server/service/cf/ctx/state/aggregation/RelatedEntitiesAggregationCalculatedFieldState.java:151`

```
149:         List<EntityId> outdated = new ArrayList<>();
150:         entityInputs.keySet().forEach(entityId -> {
151:             if (!relatedEntities.contains(entityId)) {
152:                 outdated.add(entityId);
153:                 log.warn("[{}] CF state keeps outdated related entity {}", ctx.getCfId(), entityId);
```

| Proposed | Reason | Brad |
|---|---|---|
| true | entity inputs x relatedEntities List.contains; aggregation over related entities can be many |  |

### #1263 · thingsboard/thingsboard@7a53801216 · `application/src/main/java/org/thingsboard/server/service/install/lts/V4_2_2_3Migration.java:207`

```
205:             AttributeKvEntry instructionsEntry = entriesByKey.get(legacyId + LEGACY_INSTRUCTIONS_KEY_SUFFIX);
206:             boolean saved = true;
207:             if (!alreadyInstalled.contains(mapping.itemId())) {
208:                 try {
209:                     SolutionTemplateInstalledItemDescriptor descriptor = buildLegacyDescriptor(mapping, entitiesEntry, instructionsEntry);
```

| Proposed | Reason | Brad |
|---|---|---|
| small | fixed LEGACY_SOLUTION_TEMPLATES map x alreadyInstalled list; one-off migration |  |

### #1264 · thingsboard/thingsboard@7a53801216 · `application/src/main/java/org/thingsboard/server/service/install/lts/V4_3_1_3Migration.java:271`

```
269:             AttributeKvEntry instructionsEntry = entriesByKey.get(legacyId + LEGACY_INSTRUCTIONS_KEY_SUFFIX);
270:             boolean saved = true;
271:             if (!alreadyInstalled.contains(mapping.itemId())) {
272:                 try {
273:                     SolutionTemplateInstalledItemDescriptor descriptor = buildLegacyDescriptor(mapping, entitiesEntry, instructionsEntry);
```

| Proposed | Reason | Brad |
|---|---|---|
| small | fixed LEGACY_SOLUTION_TEMPLATES map x alreadyInstalled list; one-off migration |  |

### #1270 · thingsboard/thingsboard@7a53801216 · `application/src/main/java/org/thingsboard/server/service/security/auth/oauth2/AbstractOAuth2ClientMapper.java:253`

```
251:             if (currentEntityGroups != null && !currentEntityGroups.isEmpty()) {
252:                 for (EntityGroupId currentEntityGroupId : currentEntityGroups) {
253:                     if (!addedEntityGroups.contains(currentEntityGroupId)) {
254:                         entityGroupService.removeEntityFromEntityGroup(user.getTenantId(), currentEntityGroupId, user.getId());
255:                     }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | user's current entity groups x addedEntityGroups list; a handful of groups |  |

### #1271 · thingsboard/thingsboard@7a53801216 · `application/src/main/java/org/thingsboard/server/service/subscription/TbAbstractDataSubCtx.java:242`

```
240:             if (currentValues != null) {
241:                 currentValues.forEach((k, v) -> {
242:                     if (subKeys.contains(new EntityKey(keysType, k))) {
243:                         log.trace("[{}][{}] Updating key: {} with ts: {}", serviceId, cmdId, k, v.getTs());
244:                         keyStates.put(k, v.getTs());
```

| Proposed | Reason | Brad |
|---|---|---|
| small | latest values x subKeys list; subscription keys are widget-configured, a few-dozen |  |

### #1276 · thingsboard/thingsboard@7a53801216 · `application/src/main/java/org/thingsboard/server/service/sync/vc/DefaultEntitiesVersionControlService.java:542`

```
540: 
541:         for (EntityType groupType : GROUP_ENTITIES) {
542:             if (!entityTypes.contains(groupType)) {
543:                 continue;
544:             }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | fixed GROUP_ENTITIES x entityTypes list (enum-sized) |  |

### #1278 · thingsboard/thingsboard@7a53801216 · `common/data/src/main/java/org/thingsboard/server/common/data/scheduler/WeeklyRepeat.java:37`

```
35:                 int dayOfWeek = calendar.get(Calendar.DAY_OF_WEEK);
36:                 dayOfWeek = dayOfWeek - 1; // The UI calendar starts from 0;
37:                 if (repeatOn.contains(dayOfWeek)) {
38:                     return tmp;
39:                 }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | repeatOn days-of-week list, at most 7 |  |

### #1279 · thingsboard/thingsboard@7a53801216 · `common/data/src/main/java/org/thingsboard/server/common/data/util/CollectionsUtil.java:35`

```
33:      */
34:     public static <T> List<T> diffLists(List<T> a, List<T> b) {
35:         return b.stream().filter(p -> !a.contains(p)).collect(Collectors.toList());
36:     }
37: 
```

| Proposed | Reason | Brad |
|---|---|---|
| true | generic diffLists; used by TbSqlBlockingQueue on batch lists (batch size can be 1000s) |  |

### #1286 · thingsboard/thingsboard@7a53801216 · `common/queue/src/main/java/org/thingsboard/server/queue/discovery/HashPartitionService.java:454`

```
452:                     List<ServiceInfo> services = resolveByPartitionIdx(queueServicesMap.get(queueKey), queueKey, i, responsibleServices);
453:                     log.trace("Server responsible for {}[{}] - {}", queueKey, i, services);
454:                     if (services.contains(currentService)) {
455:                         newPartitions.computeIfAbsent(queueKey, key -> new ArrayList<>()).add(i);
456:                     }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | services list per partition: a few cluster nodes |  |

### #1289 · thingsboard/thingsboard@7a53801216 · `common/report/src/main/java/org/thingsboard/server/report/renderer/chart/TbTimeSeriesChart.java:320`

```
318:             for (int i = 0; i < leftAxes.size()-1; i++) {
319:                 TimeSeriesChartYAxisSettings leftAxis = leftAxes.get(i);
320:                 int index = yAxisSettingsList.indexOf(leftAxis);
321:                 NumberAxis axis = this.yAxisList.get(index);
322:                 adjustAxisMargins(axis, 0.0, 4.0, 0.0, 0.0);
```

| Proposed | Reason | Brad |
|---|---|---|
| small | indexOf over chart y-axis settings; a few axes |  |

### #1290 · thingsboard/thingsboard@7a53801216 · `common/report/src/main/java/org/thingsboard/server/report/renderer/chart/TbTimeSeriesChart.java:340`

```
338:             for (int i = 0; i < rightAxes.size()-1; i++) {
339:                 TimeSeriesChartYAxisSettings rightAxis = rightAxes.get(i);
340:                 int index = yAxisSettingsList.indexOf(rightAxis);
341:                 NumberAxis axis = this.yAxisList.get(index);
342:                 adjustAxisMargins(axis, 0.0, 0.0, 0.0, 4.0);
```

| Proposed | Reason | Brad |
|---|---|---|
| small | indexOf over chart y-axis settings; a few axes |  |

### #1291 · thingsboard/thingsboard@7a53801216 · `common/report/src/main/java/org/thingsboard/server/report/renderer/chart/TbTimeSeriesChart.java:520`

```
518:             TimePeriodValuesCollection tpvDataset = new TimePeriodValuesCollection();
519:             for (TsChartSeriesData series : seriesList) {
520:                 int barIndex = allBarsList.indexOf(series);
521:                 TimePeriodValues timePeriods = new TimePeriodValues(datasetIndex + "_" + series.getSeriesIndex());
522:                 for (TsChartSeriesEntry tsValue : series.getData()) {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | seriesList x allBarsList.indexOf; series per report chart are config-sized |  |

### #1292 · thingsboard/thingsboard@7a53801216 · `common/report/src/main/java/org/thingsboard/server/report/renderer/chart/layout/TbTableBlockContainer.java:99`

```
97:                 double fitWidthColumnWidth = (availableColumnsWidth - fitWidthColumnsCount * horizontalGap) / fitWidthColumnsCount;
98:                 this.columns.stream().filter(c -> !c.fixedWidth()).forEach(column -> {
99:                     int index = this.columns.indexOf(column);
100:                     this.columnWidths.put(index, fitWidthColumnWidth);
101:                 });
```

| Proposed | Reason | Brad |
|---|---|---|
| small | indexOf over table columns; config-sized |  |

### #1295 · thingsboard/thingsboard@7a53801216 · `common/report/src/main/java/org/thingsboard/server/report/util/itext/PdfReportFontResolver.java:234`

```
232:             if (f != null) {
233:                 for (FontDescription fd : f.getFontDescriptions()) {
234:                     if (!fallbacks.contains(fd)) {
235:                         fallbacks.add(fd);
236:                     }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | fallback fonts list; a few font descriptions |  |

### #1299 · thingsboard/thingsboard@7a53801216 · `common/transport/lwm2m/src/main/java/org/thingsboard/server/transport/lwm2m/server/downlink/DefaultLwM2mDownlinkMsgHandler.java:777`

```
775:         List desiredFormatsList = Arrays.asList(desiredFormats);
776:         for (ContentFormat c : clientSupportContentFormats) {
777:             if (desiredFormatsList.contains(c)) {
778:                 return c;
779:             }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | content formats x 2 desired formats |  |

### #1300 · thingsboard/thingsboard@7a53801216 · `common/transport/lwm2m/src/main/java/org/thingsboard/server/transport/lwm2m/server/downlink/DefaultLwM2mDownlinkMsgHandler.java:795`

```
793:             if (observation instanceof SingleObservation singleObs) {
794:                 String idSingleOb = singleObs.getPath().toString();
795:                 if (objectIdsList.contains(idSingleOb)) {
796:                     return "Resource [" + idSingleOb + "] is already registered as SingleObservation.";
797:                 }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | client observations x objectIds; small per-device lists |  |

### #1306 · thingsboard/thingsboard@7a53801216 · `dao/src/main/java/org/thingsboard/server/dao/edge/EdgeServiceImpl.java:656`

```
654:                 List<String> missingRuleChains = new ArrayList<>();
655:                 for (RuleChainId connectedRuleChain : connectedRuleChains) {
656:                     if (!edgeRuleChainIds.contains(connectedRuleChain)) {
657:                         RuleChain ruleChainById = ruleChainService.findRuleChainById(tenantId, connectedRuleChain);
658:                         missingRuleChains.add(ruleChainById.getName());
```

| Proposed | Reason | Brad |
|---|---|---|
| small | connected chains x edgeRuleChainIds list; rule chains per edge are typically few |  |

### #1307 · thingsboard/thingsboard@7a53801216 · `dao/src/main/java/org/thingsboard/server/dao/edge/EdgeServiceImpl.java:827`

```
825:                 edgeAttributes.stream().map(KvEntry::getKey).toList();
826:         List<String> missingAttributeKeys = attributesKeys.stream()
827:                 .filter(element -> !edgeAttributeKeys.contains(element)).toList();
828:         if (missingAttributeKeys.isEmpty()) {
829:             return null;
```

| Proposed | Reason | Brad |
|---|---|---|
| small | integration config attribute keys x fetched keys; config-sized |  |

### #1309 · thingsboard/thingsboard@7a53801216 · `dao/src/main/java/org/thingsboard/server/dao/menu/CustomMenuServiceImpl.java:92`

```
90: 
91:         List<EntityId> toRemoveEntityIds = existingEntityIds.stream()
92:                 .filter(entityId -> !newAssignToList.contains(entityId))
93:                 .toList();
94:         List<EntityId> toAddEntityIds = newAssignToList.stream()
```

| Proposed | Reason | Brad |
|---|---|---|
| true | existing assignees x newAssignToList List.contains; assignee lists can be many entities |  |

### #1310 · thingsboard/thingsboard@7a53801216 · `dao/src/main/java/org/thingsboard/server/dao/menu/CustomMenuServiceImpl.java:95`

```
93:                 .toList();
94:         List<EntityId> toAddEntityIds = newAssignToList.stream()
95:                 .filter(entityId -> !existingEntityIds.contains(entityId))
96:                 .toList();
97: 
```

| Proposed | Reason | Brad |
|---|---|---|
| true | new assignees x existingEntityIds List.contains; data-derived |  |

### #1315 · thingsboard/thingsboard@7a53801216 · `dao/src/main/java/org/thingsboard/server/dao/rule/BaseRuleChainService.java:255`

```
253:                 setSingletonMode(node);
254:                 if (node.getId() != null) {
255:                     ruleNodeIndexMap.put(node.getId(), nodes.indexOf(node));
256:                 } else {
257:                     toAddOrUpdate.add(node);
```

| Proposed | Reason | Brad |
|---|---|---|
| true | nodes.indexOf per node: O(n^2) in rule-chain node count (can be hundreds) |  |

### #1317 · thingsboard/thingsboard@7a53801216 · `dao/src/main/java/org/thingsboard/server/dao/rule/BaseRuleChainService.java:313`

```
311:                     }
312:                 }
313:                 int index = nodes.indexOf(node);
314:                 nodes.set(index, savedNode);
315:                 ruleNodeIndexMap.put(savedNode.getId(), index);
```

| Proposed | Reason | Brad |
|---|---|---|
| true | nodes.indexOf per saved node: O(n^2) in rule-chain node count |  |

### #1319 · thingsboard/thingsboard@7a53801216 · `dao/src/main/java/org/thingsboard/server/dao/rule/BaseRuleChainService.java:409`

```
407:         Map<RuleNodeId, Integer> ruleNodeIndexMap = new HashMap<>();
408:         for (RuleNode node : ruleNodes) {
409:             ruleNodeIndexMap.put(node.getId(), ruleNodes.indexOf(node));
410:         }
411:         ruleChainMetaData.setNodes(ruleNodes);
```

| Proposed | Reason | Brad |
|---|---|---|
| true | ruleNodes.indexOf per node when loading metadata: O(n^2) in node count |  |

### #1335 · thingsboard/thingsboard@7a53801216 · `dao/src/main/java/org/thingsboard/server/dao/sql/query/DefaultEntityQueryRepository.java:677`

```
675:         if (isOr) {
676:             for (EntityKeyMapping m : entityFieldsFiltersMapping) {
677:                 if (!selectionMapping.contains(m)) {
678:                     m.setIgnore(true);
679:                     selectionMapping.add(m);
```

| Proposed | Reason | Brad |
|---|---|---|
| small | filter mappings x selectionMapping list: query keys, config-sized |  |

### #1336 · thingsboard/thingsboard@7a53801216 · `dao/src/main/java/org/thingsboard/server/dao/sql/query/DefaultEntityQueryRepository.java:865`

```
863:         if (isOr) {
864:             for (EntityKeyMapping m : entityFieldsFiltersMapping) {
865:                 if (!selectionMapping.contains(m)) {
866:                     m.setIgnore(true);
867:                     selectionMapping.add(m);
```

| Proposed | Reason | Brad |
|---|---|---|
| small | filter mappings x selectionMapping list: query keys, config-sized |  |

### #1340 · thingsboard/thingsboard@7a53801216 · `dao/src/main/java/org/thingsboard/server/dao/timeseries/BaseTimeseriesService.java:99`

```
97:             List<ReadTsKvQuery> filteredQueries =
98:                     queries.stream()
99:                             .filter(query -> keys.isEmpty() || keys.contains(query.getKey()))
100:                             .collect(Collectors.toList());
101:             return timeseriesDao.findAllAsync(tenantId, entityView.getEntityId(), updateQueriesForEntityView(entityView, filteredQueries));
```

| Proposed | Reason | Brad |
|---|---|---|
| small | queries x entity view timeseries keys list; config-sized |  |

### #1369 · thingsboard/thingsboard@7a53801216 · `rule-engine/rule-engine-components/src/main/java/org/thingsboard/rule/engine/metadata/TbAbstractGetAttributesNode.java:187`

```
185:     private List<String> getNonExistentKeys(List<AttributeKvEntry> existingAttributesKvEntry, List<String> allKeys) {
186:         List<String> existingKeys = existingAttributesKvEntry.stream().map(KvEntry::getKey).collect(Collectors.toList());
187:         return allKeys.stream().filter(key -> !existingKeys.contains(key)).collect(Collectors.toList());
188:     }
189: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | configured keys x existing key list; config-sized |  |


## `bpm-perf-java-find-by-key-in-loop`

### #1272 · thingsboard/thingsboard@7a53801216 · `application/src/main/java/org/thingsboard/server/service/sync/ie/importing/impl/BaseEntityImportService.java:374`

```
372: 
373:         for (CalculatedField existingField : existing) {
374:             boolean found = fieldsToSave.stream().anyMatch(importedField -> compareCalculatedFields(existingField, importedField));
375:             if (!found) {
376:                 calculatedFieldService.deleteCalculatedField(ctx.getTenantId(), existingField.getId());
```

| Proposed | Reason | Brad |
|---|---|---|
| small | existing CFs x imported CFs of one entity; a few calculated fields per entity |  |

### #1273 · thingsboard/thingsboard@7a53801216 · `application/src/main/java/org/thingsboard/server/service/sync/ie/importing/impl/BaseEntityImportService.java:382`

```
380: 
381:         for (CalculatedField calculatedField : fieldsToSave) {
382:             boolean found = existing.stream().anyMatch(existingField -> compareCalculatedFields(existingField, calculatedField));
383:             if (!found) {
384:                 calculatedFieldService.save(calculatedField);
```

| Proposed | Reason | Brad |
|---|---|---|
| small | imported CFs x existing CFs of one entity; a few |  |

### #1274 · thingsboard/thingsboard@7a53801216 · `application/src/main/java/org/thingsboard/server/service/sync/ie/importing/impl/EntityGroupImportService.java:189`

```
187: 
188:             for (GroupPermission existingPermission : existingPermissions) {
189:                 boolean exists = permissions.stream()
190:                         .anyMatch(p -> permissionsEqual(p, existingPermission));
191: 
192:                 if (!exists) {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | existing x imported permissions of one user group; typically a handful |  |

### #1275 · thingsboard/thingsboard@7a53801216 · `application/src/main/java/org/thingsboard/server/service/sync/ie/importing/impl/EntityGroupImportService.java:240`

```
238: 
239:         for (DeviceGroupOtaPackage newOtaPackage : incoming) {
240:             DeviceGroupOtaPackage oldOtaPackage = existing.stream().filter(e -> e.getOtaPackageType() == newOtaPackage.getOtaPackageType()).findFirst().orElse(null);
241:             if (!equalsGroupOtaPackage(newOtaPackage, oldOtaPackage)) {
242:                 if (oldOtaPackage != null) {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | OTA packages of one group, keyed by package type (firmware/software) |  |

### #1288 · thingsboard/thingsboard@7a53801216 · `common/report/src/main/java/org/thingsboard/server/report/renderer/chart/TbTimeSeriesChart.java:298`

```
296: 
297:         for (Map.Entry<String, Integer> yAxisEntry : this.yAxisIndexMap.entrySet()) {
298:             boolean includeZeros = this.datasetKeys.stream().anyMatch(entry ->
299:                     entry.getYAxisId().equals(yAxisEntry.getKey()) && TimeSeriesChartSeriesType.bar.equals(entry.getSeriesType()));
300:             this.yAxisList.get(yAxisEntry.getValue()).setAutoRangeIncludesZero(includeZeros);
301:         }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | y-axes x datasetKeys of one chart: config-sized |  |

### #1293 · thingsboard/thingsboard@7a53801216 · `common/report/src/main/java/org/thingsboard/server/report/service/AbstractReportService.java:393`

```
391:             }
392:             for (DataKey dataKey : dataKeys) {
393:                 entries.stream().filter(tsKvEntry -> tsKvEntry.getKey().equals(dataKey.getName()))
394:                         .findFirst()
395:                         .ifPresentOrElse(tsKvEntry -> tsValues.put(dataKey.getLabel(), formatValue(ctx, dataKey, tsKvEntry.getTs(), tsKvEntry.getValue(), false, timezone)),
396:                                 () -> tsValues.put(dataKey.getLabel(), formatValue(ctx, dataKey, 0, null, false, timezone)));
```

| Proposed | Reason | Brad |
|---|---|---|
| small | per-ts entries x dataKeys: entries per timestamp equal key count (a few) |  |

### #1298 · thingsboard/thingsboard@7a53801216 · `common/transport/lwm2m/src/main/java/org/thingsboard/server/transport/lwm2m/bootstrap/store/LwM2MBootstrapConfigStoreTaskProvider.java:262`

```
260:                 }
261:                 Integer finalServerInstanceId = serverInstanceId;
262:                 new TreeMap<>(bootstrapConfigNew.servers).values().stream()
263:                         .filter(server -> server.shortId == security.serverId)
264:                         .findFirst()
265:                         .ifPresent(server ->
```

| Proposed | Reason | Brad |
|---|---|---|
| small | bootstrap config servers: a few LwM2M servers |  |

### #1305 · thingsboard/thingsboard@7a53801216 · `dao/src/main/java/org/thingsboard/server/dao/dashboard/DashboardServiceImpl.java:545`

```
543:         Map<DashboardId, DashboardId> idMapping = new HashMap<>();
544:         for (Dashboard dashboard : dashboards) {
545:             Optional<DashboardInfo> overwriteDashboardInfoOpt = persistentDashboards.stream().filter(d -> d.getTitle().equals(dashboard.getTitle())).findAny();
546:             DashboardId importDashboardId = dashboard.getId();
547:             DashboardId overwriteDashboardId;
```

| Proposed | Reason | Brad |
|---|---|---|
| true | imported dashboards x tenant persistentDashboards by title; tenant data-derived |  |

### #1366 · thingsboard/thingsboard@7a53801216 · `rule-engine/rule-engine-components/src/main/java/org/thingsboard/rule/engine/action/TbCopyAttributesToEntityViewNode.java:87`

```
85:                                         }
86:                                         List<String> filteredAttributes =
87:                                                 attributes.stream().filter(attr -> attributeContainsInEntityView(scope, attr, entityView)).collect(Collectors.toList());
88:                                         if (!filteredAttributes.isEmpty()) {
89:                                             ctx.getTelemetryService().deleteAttributes(AttributesDeleteRequest.builder()
```

| Proposed | Reason | Brad |
|---|---|---|
| small | message attributes x entity view key list; config-sized |  |

### #1367 · thingsboard/thingsboard@7a53801216 · `rule-engine/rule-engine-components/src/main/java/org/thingsboard/rule/engine/action/TbCopyAttributesToEntityViewNode.java:98`

```
96:                                         }
97:                                     } else {
98:                                         List<AttributeKvEntry> attributes = JsonConverter.convertToAttributes(JsonParser.parseString(msg.getData())).stream()
99:                                                 .filter(attr -> attributeContainsInEntityView(scope, attr.getKey(), entityView)).toList();
100:                                         ctx.getTelemetryService().saveAttributes(AttributesSaveRequest.builder()
101:                                                 .tenantId(ctx.getTenantId())
```

| Proposed | Reason | Brad |
|---|---|---|
| small | message attributes x entity view key list; config-sized |  |

### #1368 · thingsboard/thingsboard@7a53801216 · `rule-engine/rule-engine-components/src/main/java/org/thingsboard/rule/engine/analytics/latest/telemetry/TbAggLatestTelemetryNodeV2.java:250`

```
248:         JsonObject result = new JsonObject();
249:         for (var aggMapping : config.getAggMappings()) {
250:             var filteredDataList = childDataList.stream().filter(ed -> aggMapping.getFilter() == null || filter(aggMapping.getFilter().getTbelFilterFunction(), ed)).toList();
251:             TbAggFunction aggregation = TbAggFunctionFactory.createAggFunction(aggMapping.getAggFunction());
252:             filteredDataList.forEach(childData -> {
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | per-mapping filter by TBEL predicate over children, not a key join; Map can't replace it |  |


## `bpm-perf-java-remove-front-in-loop`

### #1252 · thingsboard/thingsboard@7a53801216 · `application/src/main/java/org/thingsboard/server/config/SwaggerConfiguration.java:1201`

```
1199:         List<Class<?>> hierarchy = new ArrayList<>();
1200:         for (Class<?> c = cls; c != null && c != Object.class; c = c.getSuperclass()) {
1201:             hierarchy.add(0, c);
1202:         }
1203:         List<String> ordered = new ArrayList<>();
```

| Proposed | Reason | Brad |
|---|---|---|
| small | hierarchy.add(0) per superclass; class hierarchy depth is a few |  |

### #1294 · thingsboard/thingsboard@7a53801216 · `common/report/src/main/java/org/thingsboard/server/report/service/PdfReportService.java:493`

```
491:                     if (tsKvEntries.isEmpty() || tsKvEntries.get(0).getTs() > timeRange.startTs) {
492:                         TsKvEntry startEntry = new BasicTsKvEntry(timeRange.startTs, prev);
493:                         tsKvEntries.add(0, startEntry);
494:                     }
495:                 }
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | single add(0) per entity's list, not repeated into one growing list |  |


## `bpm-perf-kt-find-by-key-in-loop`

### #410 · immich-app/immich@f7b8ae5da3 · `mobile/android/app/src/main/kotlin/app/alextran/immich/core/HttpClientManager.kt:487`

```
485:       for (url in serverUrls) {
486:         for ((_, source) in sourceCookies) {
487:           if (store.any { it.name == source.name && it.domain == url.host && it.value == source.value }) continue
488:           store.removeAll { it.name == source.name && it.domain == url.host }
489:           store.add(rebuildCookie(source, url))
```

| Proposed | Reason | Brad |
|---|---|---|
| small | serverUrls x auth cookies x cookie store: few server URLs, a couple of auth cookies |  |

### #1547 · mihonapp/mihon@007ec9a868 · `app/src/main/java/eu/kanade/presentation/more/settings/screen/Commons.kt:24`

```
22: 
23:     val includedCategories = included
24:         .mapNotNull { id -> allCategories.find { it.id == id.toLong() } }
25:         .sortedBy { it.order }
26:     val excludedCategories = excluded
```

| Proposed | Reason | Brad |
|---|---|---|
| small | included ids x allCategories: user library categories, typically tens |  |

### #1548 · mihonapp/mihon@007ec9a868 · `app/src/main/java/eu/kanade/presentation/more/settings/screen/Commons.kt:27`

```
25:         .sortedBy { it.order }
26:     val excludedCategories = excluded
27:         .mapNotNull { id -> allCategories.find { it.id == id.toLong() } }
28:         .sortedBy { it.order }
29:     val allExcluded = excludedCategories.size == allCategories.size
```

| Proposed | Reason | Brad |
|---|---|---|
| small | excluded ids x allCategories: user library categories, typically tens |  |

### #1549 · mihonapp/mihon@007ec9a868 · `app/src/main/java/eu/kanade/presentation/more/settings/screen/SettingsDownloadScreen.kt:138`

```
136:                 message = stringResource(MR.strings.pref_download_new_categories_details),
137:                 items = allCategories,
138:                 initialChecked = included.mapNotNull { id -> allCategories.find { it.id.toString() == id } },
139:                 initialInversed = excluded.mapNotNull { id -> allCategories.find { it.id.toString() == id } },
140:                 itemLabel = { it.visualName },
```

| Proposed | Reason | Brad |
|---|---|---|
| small | included ids x allCategories: user categories, typically tens |  |

### #1550 · mihonapp/mihon@007ec9a868 · `app/src/main/java/eu/kanade/presentation/more/settings/screen/SettingsDownloadScreen.kt:139`

```
137:                 items = allCategories,
138:                 initialChecked = included.mapNotNull { id -> allCategories.find { it.id.toString() == id } },
139:                 initialInversed = excluded.mapNotNull { id -> allCategories.find { it.id.toString() == id } },
140:                 itemLabel = { it.visualName },
141:                 onDismissRequest = { showDialog = false },
```

| Proposed | Reason | Brad |
|---|---|---|
| small | excluded ids x allCategories: user categories, typically tens |  |

### #1551 · mihonapp/mihon@007ec9a868 · `app/src/main/java/eu/kanade/presentation/more/settings/screen/SettingsLibraryScreen.kt:131`

```
129:                 message = stringResource(MR.strings.pref_library_update_categories_details),
130:                 items = allCategories,
131:                 initialChecked = included.mapNotNull { id -> allCategories.find { it.id.toString() == id } },
132:                 initialInversed = excluded.mapNotNull { id -> allCategories.find { it.id.toString() == id } },
133:                 itemLabel = { it.visualName },
```

| Proposed | Reason | Brad |
|---|---|---|
| small | included ids x allCategories: user categories, typically tens |  |

### #1552 · mihonapp/mihon@007ec9a868 · `app/src/main/java/eu/kanade/presentation/more/settings/screen/SettingsLibraryScreen.kt:132`

```
130:                 items = allCategories,
131:                 initialChecked = included.mapNotNull { id -> allCategories.find { it.id.toString() == id } },
132:                 initialInversed = excluded.mapNotNull { id -> allCategories.find { it.id.toString() == id } },
133:                 itemLabel = { it.visualName },
134:                 onDismissRequest = { showCategoriesDialog = false },
```

| Proposed | Reason | Brad |
|---|---|---|
| small | excluded ids x allCategories: user categories, typically tens |  |

### #1553 · mihonapp/mihon@007ec9a868 · `app/src/main/java/mihon/domain/migration/usecases/MigrateMangaUseCase.kt:68`

```
66:                     .filter { it.isRecognizedNumber }
67:                     .map { mangaChapter ->
68:                         val prevChapter = prevMangaChapters
69:                             .find { it.isRecognizedNumber && it.chapterNumber == mangaChapter.chapterNumber }
70: 
71:                         ChapterUpdate(mangaChapter.id) {
```

| Proposed | Reason | Brad |
|---|---|---|
| true | target chapters x prevMangaChapters.find: manga can have 1000+ chapters |  |


## `bpm-perf-membership-in-list-in-loop-py`

### #681 · saleor/saleor@1771e1cf6c · `saleor/app/manifest_validations.py:105`

```
103:     permissions = [all_permissions[perm] for perm in required_permissions]
104:     permissions = split_permission_codename(permissions)
105:     return [p for p in saleor_permissions if p.codename in permissions]
106: 
107: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | saleor permission list x required perms list: bounded set of ~tens of permission codenames |  |

### #693 · saleor/saleor@1771e1cf6c · `saleor/checkout/utils.py:286`

```
284:             lines_to_update_reservation_time = []
285:             for line in checkout_lines:
286:                 if line.pk not in updated_lines_ids:
287:                     lines_to_update_reservation_time.append(line)
288: 
```

| Proposed | Reason | Brad |
|---|---|---|
| true | checkout lines x updated_lines_ids list; line counts are data-derived (size unknown, could be large) |  |

### #756 · saleor/saleor@1771e1cf6c · `saleor/discount/utils/order.py:94`

```
92: 
93:     modified_lines_info = [
94:         line_info for line_info in lines_info if line_info.line.id in affected_line_ids
95:     ]
96:     return modified_lines_info
```

| Proposed | Reason | Brad |
|---|---|---|
| true | lines_info x affected_line_ids list; order lines are data-derived |  |

### #757 · saleor/saleor@1771e1cf6c · `saleor/discount/utils/promotion.py:288`

```
286:     gift_rules = [rule for rule in rules if rule.reward_type == RewardType.GIFT]
287:     for rule in rules:
288:         if rule in gift_rules:
289:             continue
290:         discount = rule.get_discount(currency_code)
```

| Proposed | Reason | Brad |
|---|---|---|
| true | rules x gift_rules list; promotion rules are merchant data, size unknown |  |

### #758 · saleor/saleor@1771e1cf6c · `saleor/discount/utils/voucher.py:317`

```
315:             discounted_lines_by_voucher = [cheapest_line]
316:     for line_info in lines_info:
317:         if line_info in discounted_lines_by_voucher:
318:             line_info.voucher = voucher
319:             line_info.voucher_code = voucher_info.voucher_code
```

| Proposed | Reason | Brad |
|---|---|---|
| true | lines_info x discounted_lines list (LineInfo equality scan); checkout lines data-derived |  |

### #761 · saleor/saleor@1771e1cf6c · `saleor/graphql/account/types.py:883`

```
881:                 accessible_channels = [channel.id for channel in accessible_channels]
882:                 orders = [
883:                     order for order in orders if order.channel_id in accessible_channels
884:                 ]
885:             return create_connection_slice_for_sync_webhook_control_context(
```

| Proposed | Reason | Brad |
|---|---|---|
| small | orders x accessible_channels; channel count per shop is a handful |  |

### #775 · saleor/saleor@1771e1cf6c · `saleor/graphql/checkout/mutations/checkout_lines_update.py:286`

```
284:         ]
285:         if gift_lines_to_update := [
286:             line for line in lines_input if line.line_id in existing_gift_ids
287:         ]:
288:             global_ids = [
```

| Proposed | Reason | Brad |
|---|---|---|
| small | lines_input x existing gift line ids; gift lines per checkout are a handful |  |

### #814 · saleor/saleor@1771e1cf6c · `saleor/graphql/tax/mutations/tax_class_update.py:126`

```
124:             )
125:             for item in country_rates
126:             if item["country_code"] not in updated_countries
127:             and item.get("rate") is not None
128:         ]
```

| Proposed | Reason | Brad |
|---|---|---|
| small | country_rates x updated_countries; bounded by ~250 countries |  |

### #815 · saleor/saleor@1771e1cf6c · `saleor/graphql/tax/mutations/tax_configuration_update.py:356`

```
354:             )
355:             for item in countries_configuration
356:             if item["country_code"] not in updated_countries
357:         ]
358:         models.TaxConfigurationPerCountry.objects.bulk_create(to_create)
```

| Proposed | Reason | Brad |
|---|---|---|
| small | countries_configuration x updated_countries; bounded by ~250 countries |  |

### #816 · saleor/saleor@1771e1cf6c · `saleor/graphql/utils/__init__.py:154`

```
152:         nodes_pk_list.extend([str(getattr(node, old_id_field)) for node in nodes])
153:     for pk in pks:
154:         assert pk in nodes_pk_list, (
155:             f"There is no node of type {graphene_type} with pk {pk}"
156:         )
```

| Proposed | Reason | Brad |
|---|---|---|
| true | pks (request ids) x nodes_pk_list, plus pks.index in sort; grows with requested id count |  |

### #848 · saleor/saleor@1771e1cf6c · `saleor/warehouse/reservations.py:103`

```
101:     """Reserve stocks for given `checkout_lines` in given country."""
102:     variants_ids = [line.variant_id for line in checkout_lines]
103:     variants = [variant for variant in variants if variant.pk in variants_ids]
104:     variants_map = {variant.id: variant for variant in variants}
105: 
```

| Proposed | Reason | Brad |
|---|---|---|
| true | variants x variants_ids list from checkout lines; data-derived |  |

### #849 · saleor/saleor@1771e1cf6c · `saleor/warehouse/reservations.py:258`

```
256:     """Reserve preorders for given `checkout_lines` in given country."""
257:     variants_ids = [line.variant_id for line in checkout_lines]
258:     variants = [variant for variant in variants if variant.pk in variants_ids]
259:     variants_map = {variant.id: variant for variant in variants}
260: 
```

| Proposed | Reason | Brad |
|---|---|---|
| true | variants x variants_ids list from checkout lines; data-derived |  |

### #872 · zulip/zulip@36d2312680 · `tools/oneclickapps/prepare_digital_ocean_one_click_app_release.py:106`

```
104:     for record in domain.get_records():
105:         if (
106:             record.name in oneclick_test_app_record_names
107:             and record.domain == "oneclick.zulip.dev"
108:             and record.type == "A"
```

| Proposed | Reason | Brad |
|---|---|---|
| small | membership in 2-element record-name list |  |

### #874 · zulip/zulip@36d2312680 · `tools/run-mypy:60`

```
58: pyi_files = list(files_dict["pyi"])
59: python_files = [
60:     fpath for fpath in files_dict["py"] if not fpath.endswith(".py") or fpath + "i" not in pyi_files
61: ]
62: if not python_files and not pyi_files:
```

| Proposed | Reason | Brad |
|---|---|---|
| true | every .py file checked against pyi_files list; file counts grow with repo (dev tool) |  |

### #1002 · zulip/zulip@36d2312680 · `zerver/actions/streams.py:680`

```
678: 
679:             for stream_id in stream_ids:
680:                 if stream_id in web_public_stream_ids:
681:                     web_public_user_stream_ids.append(stream_id)
682:                 else:
```

| Proposed | Reason | Brad |
|---|---|---|
| true | stream_ids x web_public_stream_ids list; realm stream counts can be large |  |

### #1005 · zulip/zulip@36d2312680 · `zerver/actions/user_groups.py:173`

```
171:     full_member_group_user_ids = [user["id"] for user in full_member_group_users]
172:     members_excluding_full_members = [
173:         user for user in member_group_users if user["id"] not in full_member_group_user_ids
174:     ]
175: 
```

| Proposed | Reason | Brad |
|---|---|---|
| true | realm members x full_member_group_user_ids list; user counts grow with realm |  |

### #1008 · zulip/zulip@36d2312680 · `zerver/data_import/slack.py:387`

```
385:         if field not in slack_custom_field_name_to_zulip_custom_field_id:
386:             slack_custom_fields = ["phone", "skype"]
387:             if field in slack_custom_fields:
388:                 field_name = field
389:             else:
```

| Proposed | Reason | Brad |
|---|---|---|
| small | membership in fixed 2-element list ['phone','skype'] |  |

### #1009 · zulip/zulip@36d2312680 · `zerver/data_import/slack.py:597`

```
595: 
596:             slack_default_channels = ["general", "random"]
597:             if channel["name"] in slack_default_channels and not stream["deactivated"]:
598:                 defaultstream = build_defaultstream(realm_id, stream_id, defaultstream_id)
599:                 realm["zerver_defaultstream"].append(defaultstream)
```

| Proposed | Reason | Brad |
|---|---|---|
| small | membership in fixed 2-element list ['general','random'] |  |

### #1047 · zulip/zulip@36d2312680 · `zerver/lib/narrow_predicate.py:23`

```
21:         if operator not in supported_operators:
22:             raise JsonableError(_("Operator {operator} not supported.").format(operator=operator))
23:         if operator == "is" and narrow_term.operand in unsupported_is_operands:
24:             raise JsonableError(
25:                 _("Operand {operand} not supported.").format(operand=narrow_term.operand)
```

| Proposed | Reason | Brad |
|---|---|---|
| small | membership in fixed 1-element unsupported_is_operands list |  |

### #1062 · zulip/zulip@36d2312680 · `zerver/lib/user_groups.py:383`

```
381:         group_ids_found = [group.id for group in potential_subgroups]
382:         group_ids_not_found = [
383:             group_id for group_id in potential_subgroup_ids if group_id not in group_ids_found
384:         ]
385:         if group_ids_not_found:
```

| Proposed | Reason | Brad |
|---|---|---|
| true | request-supplied subgroup ids x group_ids_found list; size is request-derived |  |

### #1063 · zulip/zulip@36d2312680 · `zerver/lib/user_groups.py:481`

```
479:     group_ids_found = [group.id for group in potential_subgroups]
480:     group_ids_not_found = [
481:         group_id for group_id in direct_subgroups if group_id not in group_ids_found
482:     ]
483:     if group_ids_not_found:
```

| Proposed | Reason | Brad |
|---|---|---|
| true | request-supplied direct_subgroups x group_ids_found list; request-derived |  |

### #1073 · zulip/zulip@36d2312680 · `zerver/management/commands/thumbnail.py:70`

```
68:                 for existing_thumbnail in image_attachment.thumbnail_metadata:
69:                     thumb = StoredThumbnailFormat(**existing_thumbnail)
70:                     if get_image_thumbnail_path(image_attachment, thumb) in found_thumbs:
71:                         found.append(existing_thumbnail)
72:                     else:
```

| Proposed | Reason | Brad |
|---|---|---|
| small | thumbnail formats of one image x its found thumbnails: a few formats |  |

### #1086 · zulip/zulip@36d2312680 · `zerver/views/auth.py:424`

```
422:     ]
423:     for key in dict(kwargs):
424:         if key not in kwargs_to_pass:
425:             kwargs.pop(key, None)
426: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | kwargs keys x fixed ~15-name allowlist |  |

### #1156 · zulip/zulip@36d2312680 · `zilencer/views.py:795`

```
793:     deduplicated_registrations_to_return = []
794:     for registration in registrations:
795:         if registration.token in tokens_to_deduplicate and registration.user_id is not None:
796:             # user_id registrations are the ones we deleted
797:             continue
```

| Proposed | Reason | Brad |
|---|---|---|
| small | registrations x tokens_to_deduplicate for one user/kind: a few devices |  |

### #1157 · zulip/zulip@36d2312680 · `zilencer/views.py:1261`

```
1259:         remote_realm
1260:         for remote_realm in all_registered_remote_realms_for_server
1261:         if remote_realm.uuid in reported_uuids
1262:     ]
1263:     # RemoteRealm registrations that we have for this server, but aren't
```

| Proposed | Reason | Brad |
|---|---|---|
| true | remote realms of server x reported_uuids list; realm count per server data-derived |  |

### #1158 · zulip/zulip@36d2312680 · `zilencer/views.py:1269`

```
1267:         remote_realm
1268:         for remote_realm in all_registered_remote_realms_for_server
1269:         if remote_realm.uuid not in reported_uuids
1270:     ]
1271: 
```

| Proposed | Reason | Brad |
|---|---|---|
| true | remote realms of server x reported_uuids list (not in); same as above |  |

### #1159 · zulip/zulip@36d2312680 · `zilencer/views.py:1353`

```
1351:             modified = True
1352: 
1353:         if remote_realm.realm_locally_deleted and remote_realm.uuid in reported_uuids:
1354:             remote_realm.realm_locally_deleted = False
1355:             remote_realm_audit_logs.append(
```

| Proposed | Reason | Brad |
|---|---|---|
| true | inside loop over remote realms, uuid in reported_uuids list |  |

### #1208 · paperless-ngx/paperless-ngx@5f17b1a310 · `src/documents/serialisers.py:1190`

```
1188:             ):
1189:                 if (
1190:                     custom_field_instance.field not in incoming_custom_fields
1191:                     and custom_field_instance.value is not None
1192:                 ):
```

| Proposed | Reason | Brad |
|---|---|---|
| small | a document's doc-link custom fields x incoming field ids: a handful |  |


## `bpm-perf-pop-front-in-loop-py`

### #851 · saleor/saleor@1771e1cf6c · `saleor/webhook/observability/buffers.py:151`

```
149:             result = pipe.execute()
150:         for key in keys:
151:             buffer_len, _, _ = result.pop(0), result.pop(0), result.pop(0)
152:             trimmed[key] += max(0, buffer_len - self.max_size)
153:         return trimmed
```

| Proposed | Reason | Brad |
|---|---|---|
| small | result.pop(0) on pipeline result of 3 per key; keys are a few buffer names |  |

### #862 · zulip/zulip@36d2312680 · `corporate/views/remote_activity.py:206`

```
204:         support = remote_installation_support_link(server_host)
205:         links = stats + " " + support
206:         row.insert(0, links)
207: 
208:         # Count mobile users and pushes forwarded, once per server
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | row.insert(0, links) once per row on a fresh short row list; no accumulation |  |

### #1163 · zulip/zulip@36d2312680 · `zproject/backends.py:3055`

```
3053:             # verified_emails is primary.
3054:             if email_obj.get("primary"):
3055:                 verified_emails.insert(0, email_obj["email"])
3056:             else:
3057:                 verified_emails.append(email_obj["email"])
```

| Proposed | Reason | Brad |
|---|---|---|
| small | insert(0) only for the single primary email; emails per GitHub account a handful |  |

