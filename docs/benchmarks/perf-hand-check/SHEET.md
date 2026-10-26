# Hand-check marking sheet: performance rules

Generated from the run described in [README.md](README.md). Each row is one hit. **Proposed** is Claude's reading, not the verdict. Fill the **Brad** column with `true`, `small` or `wrong` (or edit `sheet.csv`, which has the same rows). The recount uses your column only.

**Marked by Brad, 2026-10-26 14:16 UTC:** "accept the proposals". His column below is the verdict; the counts at the top are recounted from it.

Labels: **true** = the shape is real and both inputs grow with data; **small** = real shape, but one input is small by design (counts as neither true nor wrong); **wrong** = not this shape.

**Which rows to mark (owner choice B, 2026-10-26):** every hit for a rule with 30 hits or fewer; for a larger rule, a seeded random sample of 30 (seed 20261026; per rule: all hits if <=30, else Fisher-Yates with mulberry32(seed ^ javaHash(rule)) over ids sorted ascending, first 30). The bar is judged on these rows: at least 5 true and precision of at least 80% among them. `proposals-all.csv` has Claude's proposed label for every W21-20 hit, sampled or not, for reference.

## Brad's counts per rule (marking set)

| Rule | All hits | Marking set | true | small | wrong | pending | Proposed precision | ≥5 true and ≥80%? |
|---|--:|--:|--:|--:|--:|--:|--:|---|
| `bpm-perf-await-in-loop` | 412 | 30 | 11 | 8 | 11 | 0 | 50% | no: precision |
| `bpm-perf-await-in-loop-py` | 4 | 4 | 0 | 2 | 2 | 0 | 0% | no: fewer than 5 true |
| `bpm-perf-copy-on-append` | 15 | 15 | 6 | 9 | 0 | 0 | 100% | yes |
| `bpm-perf-find-by-key-in-loop` | 52 | 30 | 5 | 25 | 0 | 0 | 100% | yes |
| `bpm-perf-find-by-key-in-loop-py` | 2 | 2 | 0 | 2 | 0 | 0 | — | no: fewer than 5 true |
| `bpm-perf-go-contains-in-loop` | 23 | 23 | 0 | 23 | 0 | 0 | — | no: fewer than 5 true |
| `bpm-perf-go-db-call-in-loop` | 8 | 8 | 2 | 6 | 0 | 0 | 100% | no: fewer than 5 true |
| `bpm-perf-go-defer-in-loop` | 15 | 15 | 1 | 3 | 11 | 0 | 8% | no: fewer than 5 true |
| `bpm-perf-go-nested-range-join` | 21 | 21 | 6 | 15 | 0 | 0 | 100% | yes |
| `bpm-perf-go-prepend-in-loop` | 1 | 1 | 0 | 0 | 1 | 0 | 0% | no: fewer than 5 true |
| `bpm-perf-go-regex-compile-in-loop` | 7 | 7 | 0 | 0 | 7 | 0 | 0% | no: fewer than 5 true |
| `bpm-perf-go-string-concat-in-loop` | 38 | 30 | 0 | 21 | 9 | 0 | 0% | no: fewer than 5 true |
| `bpm-perf-includes-in-loop` | 200 | 30 | 5 | 25 | 0 | 0 | 100% | yes |
| `bpm-perf-java-contains-in-loop` | 30 | 30 | 7 | 23 | 0 | 0 | 100% | yes |
| `bpm-perf-java-db-call-in-loop` | 44 | 30 | 7 | 10 | 13 | 0 | 35% | no: precision |
| `bpm-perf-java-find-by-key-in-loop` | 11 | 11 | 1 | 9 | 1 | 0 | 50% | no: fewer than 5 true |
| `bpm-perf-java-regex-compile-in-loop` | 1 | 1 | 0 | 1 | 0 | 0 | — | no: fewer than 5 true |
| `bpm-perf-java-remove-front-in-loop` | 2 | 2 | 0 | 1 | 1 | 0 | 0% | no: fewer than 5 true |
| `bpm-perf-java-string-concat-in-loop` | 25 | 25 | 2 | 13 | 10 | 0 | 17% | no: fewer than 5 true |
| `bpm-perf-json-deep-clone` | 6 | 6 | 1 | 2 | 3 | 0 | 25% | no: fewer than 5 true |
| `bpm-perf-kt-find-by-key-in-loop` | 8 | 8 | 1 | 7 | 0 | 0 | 100% | no: fewer than 5 true |
| `bpm-perf-membership-in-list-in-loop-py` | 28 | 28 | 15 | 13 | 0 | 0 | 100% | yes |
| `bpm-perf-orm-call-in-loop` | 61 | 30 | 8 | 2 | 20 | 0 | 29% | no: precision |
| `bpm-perf-orm-call-in-loop-py` | 304 | 30 | 2 | 15 | 13 | 0 | 13% | no: fewer than 5 true |
| `bpm-perf-pop-front-in-loop-py` | 3 | 3 | 0 | 2 | 1 | 0 | 0% | no: fewer than 5 true |
| `bpm-perf-regex-compile-in-loop` | 19 | 19 | 2 | 0 | 17 | 0 | 11% | no: fewer than 5 true |
| `bpm-perf-string-concat-in-loop` | 144 | 30 | 2 | 23 | 5 | 0 | 29% | no: fewer than 5 true |
| `bpm-perf-string-concat-in-loop-py` | 101 | 30 | 1 | 21 | 8 | 0 | 11% | no: fewer than 5 true |
| `bpm-perf-sync-io-in-async` | 12 | 12 | 0 | 0 | 12 | 0 | 0% | no: fewer than 5 true |
| `bpm-perf-unbounded-gather-py` | 1 | 1 | 0 | 1 | 0 | 0 | — | no: fewer than 5 true |
| `bpm-perf-unbounded-promise-all` | 125 | 30 | 5 | 21 | 4 | 0 | 56% | no: precision |

## `bpm-perf-await-in-loop`

### #146 · outline/outline@670410b236 · `server/commands/documentPermanentDeleter.ts:123`

```
121:   let totalDeleted = 0;
122:   for (let i = 0; i < destroyBatches.length; i++) {
123:     totalDeleted += await Document.scope("withDrafts").destroy({
124:       where: {
125:         id: destroyBatches[i],
126:         deletedAt: { [Op.ne]: null },
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | destroy in deliberate 10-id batches with inter-batch sleep to keep lock window short; sequential by design | wrong |

### #155 · outline/outline@670410b236 · `server/commands/groupsSyncer.ts:121`

```
119:         createdById: user.id,
120:       });
121:       await externalGroup.update({ groupId: group.id }, { transaction });
122:       externalGroup.groupId = group.id;
123:       result.groupsCreated++;
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | external-group sync writes inside one transaction; ordered find/create/update per group must be sequential | wrong |

### #237 · outline/outline@670410b236 · `server/queues/processors/ImportsProcessor.ts:529`

```
527:               color: output.color,
528:               content: transformedContent,
529:               text: await DocumentHelper.toMarkdown(transformedContent, {
530:                 includeTitle: false,
531:               }),
532:               collectionId: collectionInternalId,
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | import loop creates docs in a shared transaction with parent ordering; toMarkdown per doc is part of ordered writes | wrong |

### #268 · outline/outline@670410b236 · `server/queues/tasks/CommentUpdatedNotificationsTask.ts:60`

```
58:           NotificationEventType.MentionedInComment
59:         ) &&
60:         (await canUserAccessDocument(recipient, document.id))
61:       ) {
62:         await Notification.create({
```

| Proposed | Reason | Brad |
|---|---|---|
| small | loop over user mentions in one comment: User.findByPk + access check per mention; mentions per comment are few | small |

### #282 · outline/outline@670410b236 · `server/queues/tasks/DocumentPublishedNotificationsTask.ts:44`

```
42:         !recipient ||
43:         recipient.id === actorId ||
44:         !(await canUserAccessDocument(recipient, document.id))
45:       ) {
46:         continue;
```

| Proposed | Reason | Brad |
|---|---|---|
| true | loop over user mentions in a published doc: findByPk + canUserAccessDocument per mention; batchable, grows with doc | true |

### #328 · outline/outline@670410b236 · `server/queues/tasks/RevisionCreatedNotificationsTask.ts:183`

```
181: 
182:     for (const recipient of recipients) {
183:       const notify = await this.shouldNotify(document, recipient);
184: 
185:       if (notify) {
```

| Proposed | Reason | Brad |
|---|---|---|
| true | loop over all document notification recipients awaiting shouldNotify per recipient; independent, grows with subscribers | true |

### #329 · outline/outline@670410b236 · `server/queues/tasks/RevisionCreatedNotificationsTask.ts:186`

```
184: 
185:       if (notify) {
186:         await Notification.create({
187:           event: NotificationEventType.UpdateDocument,
188:           userId: recipient.id,
189:           revisionId: event.modelId,
```

| Proposed | Reason | Brad |
|---|---|---|
| true | Notification.create per recipient of a document update; independent inserts, could bulkCreate/parallelise | true |

### #343 · outline/outline@670410b236 · `server/queues/tasks/UpdateTeamsAttachmentsSizeTask.ts:43`

```
41: 
42:         for (const teamId of teamIds) {
43:           await new UpdateTeamAttachmentsSizeTask().schedule({ teamId });
44:         }
45:       }
```

| Proposed | Reason | Brad |
|---|---|---|
| true | per-team await schedule() inside 100-row batches; independent job enqueues, could Promise.all or bulk add | true |

### #378 · outline/outline@670410b236 · `server/services/worker.ts:66`

```
64:               // websockets are a special case on their own queue because they must
65:               // only be consumed by the websockets service rather than workers.
66:               await websocketQueue().add(job.data);
67:             } else if (
68:               ProcessorClass.applicableEvents.includes(event.name) ||
```

| Proposed | Reason | Brad |
|---|---|---|
| small | loop over the fixed set of registered processors adding queue jobs per event; bounded by code | small |

### #383 · outline/outline@670410b236 · `server/utils/CacheHelper.ts:224`

```
222: 
223:           if (keys.length > 0) {
224:             await Redis.defaultClient.unlink(...keys);
225:             deleted += keys.length;
226:           }
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | Redis SCAN cursor pagination; each unlink follows the scan page whose cursor drives the next iteration | wrong |

### #384 · outline/outline@670410b236 · `server/utils/ShutdownHelper.ts:97`

```
95:       const handlers = shutdownGroups[key];
96: 
97:       await Promise.allSettled(
98:         handlers.map(async (handler) => {
99:           Logger.debug("lifecycle", `Running shutdown handler ${handler.key}`);
100: 
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | shutdown groups run in deliberate order; each group already uses Promise.allSettled internally | wrong |

### #424 · immich-app/immich@f7b8ae5da3 · `server/src/bin/sync-sql.ts:121`

```
119:       for (const key of Object.keys(instance)) {
120:         const subInstance = (instance as any)[key];
121:         data.push(...(await this.runTargets(subInstance, `${Repository.name}.${key}`)));
122:       }
123:     }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | dev SQL-generator over a fixed handful of nested repository keys | small |

### #471 · immich-app/immich@f7b8ae5da3 · `server/src/services/database.service.ts:110`

```
108:         const isDepended = dbName === DatabaseExtension.Vector && extension === DatabaseExtension.VectorChord;
109:         if (dbName !== extension && installedVersion && !isDepended) {
110:           await this.dropExtension(dbName);
111:         }
112:       }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | drops the few installed Postgres extensions during startup; tiny fixed list, ordered DDL | small |

### #483 · immich-app/immich@f7b8ae5da3 · `server/src/services/integrity.service.ts:385`

```
383:     let total = 0;
384:     for await (const batchPaths of batched(assetPaths, JOBS_LIBRARY_PAGINATION_SIZE)) {
385:       await this.jobRepository.queue({
386:         name: JobName.IntegrityMissingFiles,
387:         data: {
388:           items: batchPaths,
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | for-await over a DB stream, queuing one job per already-batched page; streaming with backpressure | wrong |

### #504 · immich-app/immich@f7b8ae5da3 · `server/src/services/media.service.ts:87`

```
85:       }
86: 
87:       await this.jobRepository.queueAll(jobs);
88:     }
89: 
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | for-await over asset stream queuing one queueAll per batch; already batched, streaming | wrong |

### #506 · immich-app/immich@f7b8ae5da3 · `server/src/services/media.service.ts:100`

```
98:           }
99: 
100:           await this.personRepository.update({ ownerId, personGroupId, faceAssetId: face.id });
101:         }
102: 
```

| Proposed | Reason | Brad |
|---|---|---|
| true | per person missing a face: getRandomFace + update awaited one by one across all persons; N+1 on growing table | true |

### #523 · immich-app/immich@f7b8ae5da3 · `server/src/services/person.service.ts:103`

```
101:     const changeFeaturePhoto = new Map<string, PersonId>();
102:     for (const data of dto.data) {
103:       const faces = await this.personRepository.getFacesByIds(
104:         [{ personGroupId: data.personId, assetId: data.assetId }],
105:         { viewingUserId: auth.user.id },
106:       );
```

| Proposed | Reason | Brad |
|---|---|---|
| true | getFacesByIds per item of request dto.data (bulk reassign); one query per item, batchable | true |

### #524 · immich-app/immich@f7b8ae5da3 · `server/src/services/person.service.ts:109`

```
107: 
108:       for (const face of faces) {
109:         const ids = await this.checkAccess({ auth, permission: Permission.PersonCreate, ids: [face.id] });
110: 
111:         if (ids.size !== 1) {
```

| Proposed | Reason | Brad |
|---|---|---|
| true | checkAccess per face inside per-item loop over request data; could check all face ids in one call | true |

### #544 · immich-app/immich@f7b8ae5da3 · `server/src/services/storage-template.service.ts:194`

```
192:       const storageLabel = user?.storageLabel || null;
193:       const filename = asset.originalFileName || asset.id;
194:       await this.moveAsset(asset, { storageLabel, filename });
195: 
196:       if (!asset.livePhotoVideoId) {
```

| Proposed | Reason | Brad |
|---|---|---|
| true | storage migration awaits moveAsset per streamed asset across whole library; bounded concurrency possible | true |

### #549 · immich-app/immich@f7b8ae5da3 · `server/src/services/storage.service.ts:71`

```
69:           }
70: 
71:           await this.verifyReadAccess(folder);
72:           await this.verifyWriteAccess(folder);
73: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | verifies read/write on the fixed StorageFolder enum (few folders) at startup | small |

### #607 · immich-app/immich@f7b8ae5da3 · `server/src/services/sync.service.ts:899`

```
897:         }
898: 
899:         await sendEntityBackfillCompleteAck(response, backfillType, createId);
900:       }
901:     } else if (partners.length > 0) {
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | writes sync acks to a response stream in order; sequential writes are required | wrong |

### #612 · immich-app/immich@f7b8ae5da3 · `server/src/services/sync.service.ts:946`

```
944:     const upserts = this.syncRepository.assetFace.getUpsertsV2({ ...options, ack: checkpointMap[upsertType] });
945:     for await (const { updateId, ...data } of upserts) {
946:       await send(response, { type: upsertType, ids: [updateId], data });
947:     }
948:   }
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | for-await over DB stream writing ordered sync events to response stream; must be sequential | wrong |

### #625 · immich-app/immich@f7b8ae5da3 · `server/src/services/tag.service.ts:150`

```
148:       }
149: 
150:       await this.updateTags(assetId);
151:       await this.eventRepository.emit('AssetUntag', { assetId });
152:     }
```

| Proposed | Reason | Brad |
|---|---|---|
| true | updateTags + emit per asset id from request BulkIdsDto; independent per asset, grows with request | true |

### #638 · immich-app/immich@f7b8ae5da3 · `server/src/services/workflow-execution.service.ts:452`

```
450:         );
451:         if (result?.changes) {
452:           await write(
453:             {
454:               user: {
455:                 id: readResult.authUserId,
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | workflow steps run in order, each step consumes the previous step's payload/changes | wrong |

### #662 · immich-app/immich@f7b8ae5da3 · `web/src/lib/managers/timeline-manager/timeline-manager.svelte.ts:192`

```
190:       startTimelineMonth: options?.startTimelineMonth,
191:     })) {
192:       await this.loadTimelineMonth(timelineMonth.yearMonth, { cancelable: false });
193:       yield* timelineMonth.assetsIterator({ startTimelineDay, startAsset, direction });
194:       startTimelineDay = startAsset = undefined;
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | async generator lazily loading one month at a time as the consumer iterates; sequential by design | wrong |

### #671 · immich-app/immich@f7b8ae5da3 · `web/src/lib/utils/asset-utils.ts:86`

```
84:       } else {
85:         downloadUrlPost(url, archive.assetIds, archiveName);
86:         const $t = await getFormatter();
87:         const $locale = get(locale);
88:         toastManager.primary(
```

| Proposed | Reason | Brad |
|---|---|---|
| small | getFormatter awaited only in the single-archive branch, so it runs once | small |

### #673 · immich-app/immich@f7b8ae5da3 · `web/src/lib/utils/asset-utils.ts:272`

```
270:     for (const timelineMonth of timelineManager.months) {
271:       if (!timelineMonth.isLoaded) {
272:         await timelineManager.loadTimelineMonth(timelineMonth.yearMonth);
273:       }
274: 
```

| Proposed | Reason | Brad |
|---|---|---|
| true | select-all loads every unloaded timeline month sequentially; months grow with library, could load bounded-parallel | true |

### #889 · zulip/zulip@36d2312680 · `web/e2e-tests/lib/common.ts:181`

```
179:         if (typeof expected_value === "boolean") {
180:             assert.equal(
181:                 await page.$eval(
182:                     `${form_selector} input[name="${CSS.escape(name)}"]`,
183:                     (el) => el.checked,
184:                 ),
```

| Proposed | Reason | Brad |
|---|---|---|
| small | e2e test helper checking a handful of form fields with page.$eval | small |

### #1371 · thingsboard/thingsboard@7a53801216 · `ui-ngx/esbuild/tb-esbuild-plugins.ts:52`

```
50:         if (!compressFileTypes.some((ext) => ext === path.extname(file.path))) continue;
51:         if (file.contents.byteLength <= compressThreshold) continue;
52:         const compressedContent = await gzipContent(file.contents);
53:         const compressedFilePath = `${file.path}${outputExt}`;
54:         gzippedFiles.push(
```

| Proposed | Reason | Brad |
|---|---|---|
| true | build plugin gzips every output file over 10KB sequentially; hundreds of chunks, could Promise.all | true |

### #1414 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/iot-hub/device-install-dialog/device-install-dialog.component.ts:158`

```
156:           const ext = path.split('.').pop()?.toLowerCase();
157:           if (imageExtensions.has(ext)) {
158:             const blob = await entry.async('blob');
159:             const blobUrl = URL.createObjectURL(blob);
160:             this.zipImages.set(path, blobUrl);
```

| Proposed | Reason | Brad |
|---|---|---|
| small | extracts entries of a small IoT-hub template zip; few files, JSZip in-memory | small |


## `bpm-perf-await-in-loop-py`

### #409 · immich-app/immich@f7b8ae5da3 · `machine-learning/immich_ml/main.py:113`

```
111:     ]
112:     for entry in (entry for request in requests for entry in request.entries()):
113:         await _preload(entry)
114: 
115: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | preloads the configured ML models at startup; a handful of entries | small |

### #686 · saleor/saleor@1771e1cf6c · `saleor/asgi/asgi_handler.py:108`

```
106:                 task.cancel()
107:                 try:
108:                     await task
109:                 except asyncio.CancelledError:
110:                     # Task re-raised the CancelledError as expected.
```

| Proposed | Reason | Brad |
|---|---|---|
| small | awaits cancellation of at most 2 tasks (disconnect watcher + request) | small |

### #873 · zulip/zulip@36d2312680 · `tools/run-dev:271`

```
269:     while upstream_response is None:
270:         try:
271:             upstream_response = await session.request(
272:                 request.method,
273:                 request.url.with_host("127.0.0.1").with_port(upstream_port),
274:                 headers=[
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | dev proxy retry loop until upstream responds; each attempt depends on previous failure | wrong |

### #1049 · zulip/zulip@36d2312680 · `zerver/lib/push_notifications.py:182`

```
180:         for _attempt in range(APNS_MAX_RETRIES - 1):
181:             try:
182:                 return await self.apns.send_notification(request)
183:             except ProtocolError as exc:
184:                 # If aioapns tried to use a connection that APNs had already closed,
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | APNs send retry loop; next attempt only after previous ProtocolError | wrong |


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
| true | reduce spreads acc per selected element: O(k^2) copying; selections can be thousands of elements | true |

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
| true | reduce spreads acc per locked element being unlocked; O(k^2) in element count | true |

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
| true | reduce spreads growing node array per collection; total size = all top-level docs across collections | true |

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
| true | same reduce-spread over collections' children; accumulator grows with doc count | true |

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
| small | per-model field registration at class decoration time; fields per model are tens, runs once | small |

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
| small | reduce-spread over editor extensions; fixed set of a few dozen extensions | small |

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
| small | reduce-spread over editor extensions' rulePlugins; fixed small extension set | small |

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
| small | reduce-spread over input rules from fixed extension set | small |

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
| small | reduce-spread over heading levels (1-6) | small |

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
| small | reduce-spread over notification delivery methods enum (a few) | small |

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
| small | reduce-spread over notification delivery methods enum (a few) | small |

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
| small | reduce-spread over delivery method keys (a few) | small |

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
| small | reduce-spread acc has only the few alert-state keys; copy size constant | small |

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
| true | reduce-spread over scrape pool keys; O(k^2) with pools (can be hundreds) | true |

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
| true | reduce-spread over scrape pools; O(k^2) with pool count | true |


## `bpm-perf-find-by-key-in-loop`

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
| true | groupMemberships x groupUsers.some(): both store-wide collections, grows with groups/users | true |

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
| small | IntegrityReport enum values x grouped counts (one row per enum type) | small |

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
| small | outer is fixed 3-element visibilityOrder; assets is one duplicate group, O(3n) not n*m | small |

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
| small | newFiles x oldFiles of one asset: a few file types (thumbnail/preview/fullsize) per asset | small |

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
| true | doc-link ids x results.find; links per field data-derived (usually modest) | true |

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
| true | selected doc ids x results.find; doc-link selections data-derived (usually modest) | true |

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
| small | title search results (truncated page) x manually selected docs | small |

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
| true | doc tags x all tags list; tag catalogs can be thousands; getter may run per render | true |

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
| small | display fields x allDisplayFields: fixed small field list | small |

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
| small | sort-order ids x dashboardViews (find + includes); saved views per user are tens | small |

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
| small | dedupe of Angular modules list; tens of modules | small |

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
| small | operation types x allOperationTypeList enum-sized list | small |

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
| small | keyVals x selectOptions: fixed field options list | small |

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
| small | selectOptions x deleteFieldsArray: fixed field options list | small |

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
| small | ctx.data x dataItems: widget data keys (config); could grow with multi-entity aliases | small |

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
| small | dataItems x legendItems: widget data keys (config) | small |

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
| small | dataItems x options.series: chart series (config-sized) | small |

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
| small | dataItems x ctx.data per update: chart keys config-sized; grows with multi-entity datasources | small |

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
| small | thresholds x latestData: a few thresholds | small |

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
| small | loop over y-axes (a few) with find in latestData | small |

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
| small | saved value keys x datasource dataKeys: a few keys | small |

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
| small | walks a short id path through nested form properties; not a join | small |

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
| small | default values x select items: form config | small |

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
| small | validatorTriggers x properties: form config | small |

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
| small | behaviors x groups of one SCADA symbol: config-sized | small |

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
| small | widgetLayouts x dashboardWidgets.findIndex: widgets per dashboard tens | small |

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
| small | customers x users x relations.some: AI-generated solution description, tens of entities | small |

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
| small | existing tags x symbol tags of one SCADA symbol: a few | small |

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
| true | data keys x origData.find: entity attributes list can be hundreds | true |

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
| small | source x target dataKeys of map datasources: config-sized | small |


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
| small | next() over one select field's options per custom field; options are a short config list | small |

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
| small | same generator as 1231 (select options of one field); short config list | small |


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
| small | selectors x allowedSelectors[role]: a few roles | small |

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
| small | base labels x b.del: labels per series ~10 (hot path but tiny lists) | small |

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
| small | prevBounds x customValues: histogram bucket bounds, tens | small |

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
| small | run attempts x passThroughAttemptIDs: a few attempts per job | small |

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
| small | membership in fixed 4-element countedReviewTypes | small |

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
| small | workflow filter types x capabilities: a few | small |

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
| small | workflow action types x capabilities: a few | small |

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
| small | test helper: response headers x ignoredHeaders list | small |

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
| small | configured URL schemes x xurls.SchemesNoAuthority: small fixed lists | small |

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
| small | search results page x loadRepoIDs: bounded by page size | small |

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
| small | search results page x loadRepoIDs: bounded by page size | small |

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
| small | fixed goth providers x existing Azure sources | small |

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
| small | codegen tool: imports x IncludedImports config list | small |

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
| small | codegen tool: scope names x ExcludedTypes config list | small |

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
| small | router entrypoints x configured entryPoints: a few entry points | small |

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
| small | router entrypoints x configured entryPoints: a few | small |

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
| small | router entrypoints x configured entryPoints: a few | small |

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
| small | provider precedence x providerNames: a few | small |

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
| small | configured encodings x 3 supported encodings | small |

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
| small | client ALPN protos x configured protos: a few | small |

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
| small | conditions x fixed gatewayConditionTypes | small |

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
| small | listener conditions x fixed listenerConditionTypes | small |

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
| small | CrossProviderNamespaces config list per ingress; a few namespaces | small |


## `bpm-perf-go-db-call-in-loop`

### #1589 · go-gitea/gitea@85211296dd · `modelmigration/v1_22/v286.go:46`

```
44: 			}
45: 			for _, s := range droppedIndexes {
46: 				_, err := db.Exec(s)
47: 				if err != nil {
48: 					return errors.New(s + " " + err.Error())
```

| Proposed | Reason | Brad |
|---|---|---|
| small | migration drops 3 fixed MSSQL indexes; constant DDL list | small |

### #1590 · go-gitea/gitea@85211296dd · `modelmigration/v1_22/v286.go:56`

```
54: 			var err error
55: 			if setting.Database.Type.IsMySQL() {
56: 				_, err = db.Exec(fmt.Sprintf("ALTER TABLE `%s` MODIFY COLUMN `%s` VARCHAR(64)", alts[0], alts[1]))
57: 			} else if setting.Database.Type.IsMSSQL() {
58: 				_, err = db.Exec(fmt.Sprintf("ALTER TABLE [%s] ALTER COLUMN [%s] NVARCHAR(64)", alts[0], alts[1]))
```

| Proposed | Reason | Brad |
|---|---|---|
| small | migration ALTERs a fixed list of table/column pairs; DDL cannot be batched meaningfully | small |

### #1591 · go-gitea/gitea@85211296dd · `modelmigration/v1_22/v286.go:58`

```
56: 				_, err = db.Exec(fmt.Sprintf("ALTER TABLE `%s` MODIFY COLUMN `%s` VARCHAR(64)", alts[0], alts[1]))
57: 			} else if setting.Database.Type.IsMSSQL() {
58: 				_, err = db.Exec(fmt.Sprintf("ALTER TABLE [%s] ALTER COLUMN [%s] NVARCHAR(64)", alts[0], alts[1]))
59: 			} else {
60: 				_, err = db.Exec(fmt.Sprintf("ALTER TABLE `%s` ALTER COLUMN `%s` TYPE VARCHAR(64)", alts[0], alts[1]))
```

| Proposed | Reason | Brad |
|---|---|---|
| small | migration ALTERs a fixed list of table/column pairs (MSSQL branch) | small |

### #1592 · go-gitea/gitea@85211296dd · `modelmigration/v1_22/v286.go:60`

```
58: 				_, err = db.Exec(fmt.Sprintf("ALTER TABLE [%s] ALTER COLUMN [%s] NVARCHAR(64)", alts[0], alts[1]))
59: 			} else {
60: 				_, err = db.Exec(fmt.Sprintf("ALTER TABLE `%s` ALTER COLUMN `%s` TYPE VARCHAR(64)", alts[0], alts[1]))
61: 			}
62: 			if err != nil {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | migration ALTERs a fixed list of table/column pairs (Postgres branch) | small |

### #1593 · go-gitea/gitea@85211296dd · `modelmigration/v1_22/v286.go:74`

```
72: 			}
73: 			for _, s := range recreateIndexes {
74: 				_, err := db.Exec(s)
75: 				if err != nil {
76: 					return errors.New(s + " " + err.Error())
```

| Proposed | Reason | Brad |
|---|---|---|
| small | migration recreates 3 fixed MSSQL indexes | small |

### #1609 · go-gitea/gitea@85211296dd · `models/repostats/repo.go:299`

```
297: 	return db.WithTx(ctx, func(ctx context.Context) error {
298: 		for _, user := range users {
299: 			if _, err := db.Exec(ctx, "UPDATE `user` SET num_stars=(SELECT COUNT(*) FROM `star` WHERE uid=?) WHERE id=?", user.ID, user.ID); err != nil {
300: 				return err
301: 			}
```

| Proposed | Reason | Brad |
|---|---|---|
| true | one UPDATE per user recomputing num_stars over all users in batches; one set-based UPDATE would do | true |

### #1611 · go-gitea/gitea@85211296dd · `models/unittest/fixtures_loader.go:138`

```
136: 	}
137: 	for i := range fixture.sqlInserts {
138: 		_, err = tx.Exec(fixture.sqlInserts[i], fixture.sqlInsertArgs[i]...)
139: 	}
140: 	if err != nil {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | test fixture loader inserting fixture rows; test-only, small data | small |

### #1659 · go-gitea/gitea@85211296dd · `services/projects/issue.go:199`

```
197: 		// that moving an issue's column in one project doesn't affect its column in other
198: 		// projects when the issue is assigned to multiple projects.
199: 		_, err = db.Exec(ctx, "UPDATE `project_issue` SET project_board_id=?, sorting=? WHERE issue_id=? AND project_id=?",
200: 			column.ID, sorting, issueID, column.ProjectID)
201: 		if err != nil {
202: 			return nil, err
```

| Proposed | Reason | Brad |
|---|---|---|
| true | per issue in a column reorder: ProjectColumnMap query + UPDATE; grows with column size, batchable via CASE | true |


## `bpm-perf-go-defer-in-loop`

### #1561 · prometheus/prometheus@a83f7158e7 · `scrape/manager.go:399`

```
397: 	for _, s := range oldScrapeFailureLoggers {
398: 		if s != nil {
399: 			defer s.Close()
400: 		}
401: 	}
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | intentional: closes the old failure loggers at function exit after swapping in new ones | wrong |

### #1564 · prometheus/prometheus@a83f7158e7 · `tsdb/compact.go:626`

```
624: 				return nil, err
625: 			}
626: 			defer b.Close()
627: 		}
628: 
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | opened blocks must stay open until compaction finishes using them after the loop | wrong |

### #1565 · prometheus/prometheus@a83f7158e7 · `tsdb/head_append.go:1822`

```
1820: 		acc.histogramsAppended += len(b.histograms) + len(b.floatHistograms)
1821: 		a.commitExemplars(b)
1822: 		defer b.close(h)
1823: 	}
1824: 	defer h.metrics.activeAppenders.Dec()
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | batches deliberately closed at end of commit after all are processed | wrong |

### #1566 · prometheus/prometheus@a83f7158e7 · `tsdb/wlog/wlog.go:388`

```
386: 		case donec := <-w.stopc:
387: 			close(w.actorc)
388: 			defer close(donec)
389: 			break Loop
390: 		}
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | defer then break Loop immediately; executes once | wrong |

### #1594 · go-gitea/gitea@85211296dd · `modelmigration/v1_9/v82.go:92`

```
90: 					return err
91: 				}
92: 				defer gitRepo.Close()
93: 				gitRepoCache[release.RepoID] = gitRepo
94: 			}
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | git repos are cached in gitRepoCache and reused across iterations, so must stay open until return | wrong |

### #1615 · go-gitea/gitea@85211296dd · `modules/lfs/filesystem_client.go:53`

```
51: 			return err
52: 		}
53: 		defer f.Close()
54: 		if err := callback(p, f, nil); err != nil {
55: 			return err
```

| Proposed | Reason | Brad |
|---|---|---|
| true | LFS Download keeps every opened object file open until all objects are processed; objects list grows | true |

### #1623 · go-gitea/gitea@85211296dd · `modules/packages/composer/metadata.go:142`

```
140: 				return nil, err
141: 			}
142: 			defer f.Close()
143: 
144: 			return util.ReadWithLimit(f, limit)
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | defer followed by return in the same iteration; runs at most once | wrong |

### #1624 · go-gitea/gitea@85211296dd · `modules/packages/conda/metadata.go:113`

```
111: 				return nil, err
112: 			}
113: 			defer f.Close()
114: 
115: 			dec, err := zstd.NewReader(f)
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | defer followed by return in the same iteration; runs at most once | wrong |

### #1625 · go-gitea/gitea@85211296dd · `modules/packages/conda/metadata.go:119`

```
117: 				return nil, err
118: 			}
119: 			defer dec.Close()
120: 
121: 			p, err := parsePackageTar(dec)
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | defer followed by return in the same iteration; runs at most once | wrong |

### #1626 · go-gitea/gitea@85211296dd · `modules/packages/cran/metadata.go:138`

```
136: 				return nil, err
137: 			}
138: 			defer f.Close()
139: 
140: 			p, err := ParseDescription(f)
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | defer followed by return in the same iteration; runs at most once | wrong |

### #1627 · go-gitea/gitea@85211296dd · `modules/packages/debian/metadata.go:116`

```
114: 					return nil, err
115: 				}
116: 				defer gzr.Close()
117: 
118: 				inner = gzr
```

| Proposed | Reason | Brad |
|---|---|---|
| small | defer gzip reader for the control.tar member of a .deb; only one such member, so at most once | small |

### #1628 · go-gitea/gitea@85211296dd · `modules/packages/debian/metadata.go:131`

```
129: 					return nil, err
130: 				}
131: 				defer zr.Close()
132: 
133: 				inner = zr
```

| Proposed | Reason | Brad |
|---|---|---|
| small | defer zstd reader for the control.tar member of a .deb; only one such member, so at most once | small |

### #1629 · go-gitea/gitea@85211296dd · `modules/packages/goproxy/metadata.go:83`

```
81: 				return nil, err
82: 			}
83: 			defer f.Close()
84: 
85: 			bytes, err := io.ReadAll(&io.LimitedReader{R: f, N: maxGoModFileSize})
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | defer followed by return after reading go.mod; runs at most once | wrong |

### #1630 · go-gitea/gitea@85211296dd · `modules/packages/nuget/metadata.go:158`

```
156: 				return nil, err
157: 			}
158: 			defer f.Close()
159: 
160: 			return ParseNuspecMetaData(archive, f)
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | defer followed by return after nuspec parse; runs at most once | wrong |

### #1722 · traefik/traefik@f1f227eda7 · `pkg/tls/ocsp.go:175`

```
173: 			continue
174: 		}
175: 		defer res.Body.Close()
176: 
177: 		if res.StatusCode/100 != 2 {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | OCSP responders per cert (usually 1-2); failed bodies stay open until return | small |


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
| small | del names x builder.add labels: a few labels | small |

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
| small | migration: unit types (fixed ~10) x teams x team units | small |

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
| true | notifications x deduped reposList scan; grows with notifications/repos per page | true |

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
| small | GPG subkeys x original subkeys: a few | small |

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
| small | default app config names x builtin apps (a few) | small |

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
| small | issues x issuePins; pins are capped (max pinned issues per repo) | small |

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
| true | issueUsers x issues: both scale with issue list length | true |

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
| small | pinned issues x pins; capped max pinned count | small |

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
| small | closing/reopening refs to one PR; dedupe over a few | small |

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
| small | detected licenses x old licenses of one repo: a few | small |

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
| small | disabled units x fixed repo unit list | small |

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
| small | files of one package version (cached pd): a few files | small |

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
| true | incoming updates x vm.Updates scan by ID; RPM updateinfo advisories grow with repo | true |

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
| small | pkg collections of one update: a few | small |

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
| small | candidate reviewers x preadded review requests (a few) | small |

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
| small | candidate teams x preadded team review requests (a few) | small |

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
| small | fixed accesses list x repo units (~10) | small |

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
| true | cancelledJobs x jobs of a run; matrix runs can have hundreds of jobs | true |

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
| small | pkg collections of one update: a few | small |

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
| true | summaryResults x repos list: both scale with repos listed | true |

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
| true | newCertificates x certificates scan; TLS certs across providers can be hundreds+ | true |


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
| wrong | prepend only in len(ss)==1 case; ss is capped at 2 elements | wrong |


## `bpm-perf-go-regex-compile-in-loop`

### #1560 · prometheus/prometheus@a83f7158e7 · `promql/promqltest/test.go:734`

```
732: 		if cmd.fail && strings.HasPrefix(defLine, "expected_fail_regexp") {
733: 			pattern := strings.TrimSpace(strings.TrimPrefix(defLine, "expected_fail_regexp"))
734: 			cmd.expectedFailRegexp, err = regexp.Compile(pattern)
735: 			if err != nil {
736: 				return i, nil, formatErr("invalid regexp '%s' for expected_fail_regexp: %w", pattern, err)
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | compiles a distinct user-supplied pattern then breaks; nothing to hoist | wrong |

### #1581 · go-gitea/gitea@85211296dd · `modelmigration/base/db.go:365`

```
363: 		// Remove the required columnNames
364: 		for _, name := range columnNames {
365: 			tableSQL = regexp.MustCompile(regexp.QuoteMeta("`"+name+"`")+"[^`,)]*?[,)]").ReplaceAllString(tableSQL, "")
366: 		}
367: 
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | regexp differs per column name (QuoteMeta of name); cannot hoist; migration-only | wrong |

### #1622 · go-gitea/gitea@85211296dd · `modules/markup/sanitizer_custom.go:25`

```
23: 					panic("Markup sanitizer rule regexp must start with ^ and end with $ to be strict")
24: 				}
25: 				policy.AllowAttrs(rule.AllowAttr).Matching(regexp.MustCompile(rule.Regexp)).OnElements(rule.Element)
26: 			} else {
27: 				policy.AllowAttrs(rule.AllowAttr).OnElements(rule.Element)
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | compiles each distinct config sanitizer rule once at setup; nothing to hoist | wrong |

### #1713 · traefik/traefik@f1f227eda7 · `pkg/middlewares/headers/header.go:34`

```
32: 	regexes := make([]*regexp.Regexp, len(cfg.AccessControlAllowOriginListRegex))
33: 	for i, str := range cfg.AccessControlAllowOriginListRegex {
34: 		reg, err := regexp.Compile(str)
35: 		if err != nil {
36: 			return nil, fmt.Errorf("error occurred during origin parsing: %w", err)
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | compiles each distinct configured origin regex once at middleware construction | wrong |

### #1714 · traefik/traefik@f1f227eda7 · `pkg/middlewares/stripprefixregex/strip_prefix_regex.go:35`

```
33: 
34: 	for _, exp := range config.Regex {
35: 		reg, err := regexp.Compile(strings.TrimSpace(exp))
36: 		if err != nil {
37: 			return nil, err
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | compiles each distinct configured regex once at middleware construction | wrong |

### #1716 · traefik/traefik@f1f227eda7 · `pkg/muxer/tcp/matcher_v2.go:141`

```
139: 		}
140: 
141: 		regexp, err := regexp.Compile(preparedPattern)
142: 		if err != nil {
143: 			return err
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | compiles each distinct HostSNIRegexp template once at router build | wrong |

### #1717 · traefik/traefik@f1f227eda7 · `pkg/muxer/tcp/matcher_v2.go:151`

```
149: 	tree.matcher = func(meta ConnData) bool {
150: 		for _, regexp := range regexps {
151: 			if regexp.MatchString(meta.serverName) {
152: 				return true
153: 			}
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | MatchString on precompiled regexps, no compile in loop | wrong |


## `bpm-perf-go-string-concat-in-loop`

### #1558 · prometheus/prometheus@a83f7158e7 · `promql/parser/generated_parser.y.go:990`

```
988: 	for i, tok := range expected {
989: 		if i == 0 {
990: 			res += ", expecting "
991: 		} else {
992: 			res += " or "
```

| Proposed | Reason | Brad |
|---|---|---|
| small | yacc error message over capped expected-token list (few tokens) | small |

### #1559 · prometheus/prometheus@a83f7158e7 · `promql/parser/generated_parser.y.go:992`

```
990: 			res += ", expecting "
991: 		} else {
992: 			res += " or "
993: 		}
994: 		res += yyTokname(tok)
```

| Proposed | Reason | Brad |
|---|---|---|
| small | yacc error message over capped expected-token list (few tokens) | small |

### #1562 · prometheus/prometheus@a83f7158e7 · `scrape/scrape.go:803`

```
801: 			val += ";" + model.EscapingKey + "=" + scheme.String()
802: 		}
803: 		val += fmt.Sprintf(";q=0.%d", weight)
804: 		vals = append(vals, val)
805: 		weight--
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | val is fresh each iteration with one append; no accumulation across iterations | wrong |

### #1577 · prometheus/prometheus@a83f7158e7 · `web/ui/mantine-ui/src/promql/tools/gen_functions_docs/main.go:132`

```
130: 			}
131: 		} else {
132: 			currentDocs += line
133: 		}
134: 	}
```

| Proposed | Reason | Brad |
|---|---|---|
| small | build-time docs generator accumulating lines of one function section; small input | small |

### #1582 · go-gitea/gitea@85211296dd · `modelmigration/base/db.go:406`

```
404: 		for _, col := range columnNames {
405: 			if cols != "" {
406: 				cols += ", "
407: 			}
408: 			cols += "DROP COLUMN `" + col + "` CASCADE"
```

| Proposed | Reason | Brad |
|---|---|---|
| small | migration joins a few dropped column names | small |

### #1584 · go-gitea/gitea@85211296dd · `modelmigration/base/db.go:434`

```
432: 		for _, col := range columnNames {
433: 			if cols != "" {
434: 				cols += ", "
435: 			}
436: 			cols += "DROP COLUMN `" + col + "`"
```

| Proposed | Reason | Brad |
|---|---|---|
| small | migration joins a few dropped column names | small |

### #1586 · go-gitea/gitea@85211296dd · `modelmigration/base/db.go:445`

```
443: 		for _, col := range columnNames {
444: 			if cols != "" {
445: 				cols += ", "
446: 			}
447: 			cols += "`" + strings.ToLower(col) + "`"
```

| Proposed | Reason | Brad |
|---|---|---|
| small | migration joins a few column names (MSSQL) | small |

### #1587 · go-gitea/gitea@85211296dd · `modelmigration/base/db.go:447`

```
445: 				cols += ", "
446: 			}
447: 			cols += "`" + strings.ToLower(col) + "`"
448: 		}
449: 		sql := fmt.Sprintf("SELECT Name FROM sys.default_constraints WHERE parent_object_id = OBJECT_ID('%[1]s') AND parent_column_id IN (SELECT column_id FROM sys.columns WHERE LOWER(name) IN (%[2]s) AND object_id = OBJECT_ID('%[1]s'))",
```

| Proposed | Reason | Brad |
|---|---|---|
| small | migration joins a few column names (MSSQL) | small |

### #1603 · go-gitea/gitea@85211296dd · `models/issues/pull.go:961`

```
959: 	for _, char := range line {
960: 		if escape {
961: 			token += string(char)
962: 			escape = false
963: 		} else if string(char) == "\\" {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | per-char token building in one CODEOWNERS line; tokens are short | small |

### #1604 · go-gitea/gitea@85211296dd · `models/issues/pull.go:973`

```
971: 			}
972: 		} else {
973: 			token += string(char)
974: 		}
975: 	}
```

| Proposed | Reason | Brad |
|---|---|---|
| small | per-char token building in one CODEOWNERS line; tokens are short | small |

### #1613 · go-gitea/gitea@85211296dd · `modules/auth/password/password.go:67`

```
65: 		for _, val := range values {
66: 			if complexity, ok := charComplexities[val]; ok {
67: 				validChars += complexity.ValidChars
68: 				requiredList = append(requiredList, complexity)
69: 			}
```

| Proposed | Reason | Brad |
|---|---|---|
| small | concatenates a few fixed password-complexity char classes once at setup | small |

### #1614 · go-gitea/gitea@85211296dd · `modules/auth/password/password.go:74`

```
72: 			// No valid character classes found; use all classes as default
73: 			for _, complexity := range charComplexities {
74: 				validChars += complexity.ValidChars
75: 				requiredList = append(requiredList, complexity)
76: 			}
```

| Proposed | Reason | Brad |
|---|---|---|
| small | concatenates the fixed default char classes once at setup | small |

### #1618 · go-gitea/gitea@85211296dd · `modules/markup/html_commit.go:184`

```
182: 		text := text1 + textDots + text2
183: 		if hash != "" {
184: 			text += " (" + hash + ")"
185: 		}
186: 		replaceContent(node, start, end, createCodeLink(urlFull, text, "compare"))
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | text is fresh per node with a single append; no accumulation across iterations | wrong |

### #1619 · go-gitea/gitea@85211296dd · `modules/markup/html_issue.go:56`

```
54: 		if m[4] != -1 && m[5] != -1 {
55: 			if locale, ok := ctx.Value(translation.ContextKey).(translation.Locale); ok {
56: 				text += " " + locale.TrString("repo.from_comment")
57: 			} else {
58: 				text += " (comment)"
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | single append to a freshly built link text; not accumulating in a loop | wrong |

### #1620 · go-gitea/gitea@85211296dd · `modules/markup/html_issue.go:58`

```
56: 				text += " " + locale.TrString("repo.from_comment")
57: 			} else {
58: 				text += " (comment)"
59: 			}
60: 		}
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | single append to a freshly built link text; not accumulating in a loop | wrong |

### #1621 · go-gitea/gitea@85211296dd · `modules/markup/html_link.go:93`

```
91: 		}
92: 
93: 		name += tail
94: 		image := false
95: 		ext := path.Ext(link)
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | single append to fresh name per link; not accumulating | wrong |

### #1631 · go-gitea/gitea@85211296dd · `modules/setting/config_env.go:72`

```
70: 		}
71: 		if inKey {
72: 			key += string(decodedBytes)
73: 		} else {
74: 			section += string(decodedBytes)
```

| Proposed | Reason | Brad |
|---|---|---|
| small | decodes a few escaped sequences in one env var name | small |

### #1632 · go-gitea/gitea@85211296dd · `modules/setting/config_env.go:74`

```
72: 			key += string(decodedBytes)
73: 		} else {
74: 			section += string(decodedBytes)
75: 		}
76: 		last = unescapeIdx[1]
```

| Proposed | Reason | Brad |
|---|---|---|
| small | decodes a few escaped sequences in one env var name | small |

### #1633 · go-gitea/gitea@85211296dd · `modules/timeutil/since.go:105`

```
103: 
104: 		diff, diffStr = computeTimeDiffFloor(diff, lang)
105: 		timeStr += ", " + diffStr
106: 	}
107: 	return strings.TrimPrefix(timeStr, ", ")
```

| Proposed | Reason | Brad |
|---|---|---|
| small | time-since string over at most a handful of time units | small |

### #1634 · go-gitea/gitea@85211296dd · `modules/translation/mock.go:33`

```
31: 		switch v := arg.(type) {
32: 		case string:
33: 			ret += v + ","
34: 		default:
35: 			ret += fmt.Sprint(v) + ","
```

| Proposed | Reason | Brad |
|---|---|---|
| small | mock locale (tests) concatenating 1-2 args, as the code comment notes | small |

### #1636 · go-gitea/gitea@85211296dd · `modules/translation/mock.go:47`

```
45: 		switch v := arg.(type) {
46: 		case template.HTML:
47: 			ret += v + ","
48: 		case string:
49: 			ret += template.HTML(html.EscapeString(v)) + ","
```

| Proposed | Reason | Brad |
|---|---|---|
| small | mock locale (tests) concatenating 1-2 args | small |

### #1637 · go-gitea/gitea@85211296dd · `modules/translation/mock.go:49`

```
47: 			ret += v + ","
48: 		case string:
49: 			ret += template.HTML(html.EscapeString(v)) + ","
50: 		default:
51: 			ret += template.HTML(html.EscapeString(fmt.Sprint(v))) + ","
```

| Proposed | Reason | Brad |
|---|---|---|
| small | mock locale (tests) concatenating 1-2 args | small |

### #1643 · go-gitea/gitea@85211296dd · `routers/private/manager_process.go:118`

```
116: 			}
117: 			_, _ = fmt.Fprintf(sb, "\n")
118: 			indent += "| "
119: 			if len(stack.Labels) > 0 {
120: 				_, _ = fmt.Fprintf(sb, "%sLabels:      %q:%q", indent, stack.Labels[0].Name, stack.Labels[0].Value)
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | indent is re-declared each iteration (shadowed copy); writes go to a strings.Builder | wrong |

### #1644 · go-gitea/gitea@85211296dd · `routers/private/manager_process.go:130`

```
128: 			}
129: 			_, _ = fmt.Fprintf(sb, "%sStack:\n", indent)
130: 			indent += "  "
131: 			for _, entry := range stack.Entry {
132: 				_, _ = fmt.Fprintf(sb, "%s+ %s\n", indent, entry.Function)
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | indent is a per-iteration shadowed copy, grows by 2 chars once; output uses a Builder | wrong |

### #1646 · go-gitea/gitea@85211296dd · `routers/web/feed/convert.go:210`

```
208: 				for _, commit := range push.Commits {
209: 					if len(desc) != 0 {
210: 						desc += "\n\n"
211: 					}
212: 					desc += fmt.Sprintf("<a href=\"%s\">%s</a>\n%s",
```

| Proposed | Reason | Brad |
|---|---|---|
| small | feed description over commits of one push action; feed commit count is capped | small |

### #1647 · go-gitea/gitea@85211296dd · `routers/web/feed/convert.go:212`

```
210: 						desc += "\n\n"
211: 					}
212: 					desc += fmt.Sprintf("<a href=\"%s\">%s</a>\n%s",
213: 						html.EscapeString(fmt.Sprintf("%s/commit/%s", act.GetRepoAbsoluteLink(ctx), commit.Sha1)),
214: 						commit.Sha1,
215: 						renderUtils.RenderCommitMessage(commit.Message, act.Repo),
```

| Proposed | Reason | Brad |
|---|---|---|
| small | feed description over commits of one push action; feed commit count is capped | small |

### #1648 · go-gitea/gitea@85211296dd · `routers/web/feed/convert.go:232`

```
230: 				comment := act.GetIssueInfos()[1]
231: 				if len(comment) != 0 {
232: 					desc += "\n\n" + string(renderCommentMarkdown(ctx, act, comment, true))
233: 				}
234: 			case activities_model.ActionMergePullRequest, activities_model.ActionAutoMergePullRequest:
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | single append inside a switch case, not accumulating in the loop | wrong |

### #1653 · go-gitea/gitea@85211296dd · `routers/web/user/setting/keys.go:142`

```
140: 		keyIDs := ""
141: 		for _, key := range keys {
142: 			keyIDs += key.KeyID
143: 			keyIDs += ", "
144: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | joins key IDs of one uploaded GPG key block; a handful of keys | small |

### #1657 · go-gitea/gitea@85211296dd · `services/gitdiff/gitdiff.go:1261`

```
1259: 			var suffix string
1260: 			_, _ = fmt.Fscanf(rd, "%s ", &suffix)
1261: 			name += " " + suffix
1262: 			char, _ = rd.ReadByte()
1263: 			_ = rd.UnreadByte()
```

| Proposed | Reason | Brad |
|---|---|---|
| small | rebuilds a filename with spaces from a diff header; few words | small |

### #1706 · traefik/traefik@f1f227eda7 · `internal/gendoc.go:72`

```
70: 
71: 		if flat.Default == "" {
72: 			line += "|"
73: 		} else {
74: 			line += flat.Default + " |"
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | line is fresh per flag with one append; written out each iteration | wrong |


## `bpm-perf-includes-in-loop`

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
| true | all scene elements x ids of selected frames; both grow with the drawing, size unknown, data-derived | true |

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
| true | dropped library itemIds x whole library items; both user data, size unknown | true |

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
| small | invitedInSession = ids invited in this dialog session (few) in sort comparator over group memberships | small |

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
| small | invitedInSession = ids invited in this dialog session (few) in sort comparator over group memberships | small |

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
| true | userIds of group members x all active/invited users; both grow with team size | true |

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
| small | userIdsMentioned = users mentioned in one comment (few) vs notification recipients | small |

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
| true | mentionedUser dedupe grows to group size over all GroupUser rows of a group; O(g^2), though DB awaits dominate | true |

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
| small | operand_ids x users in one DM conversation; DM groups are small | small |

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
| small | elementsFromPoint returns the DOM stack at a point (a few elements) | small |

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
| small | ML-suggested ids x applied ids on one document; suggestion lists are a handful (unsure) | small |

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
| small | excludes is a handful of fixed field names pushed by settings checks | small |

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
| small | widget aggTsValues keys x keys in one subscription update; per-widget configured keys (unsure) | small |

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
| small | relation filter entityTypes x requested entityTypes; both drawn from EntityType enum | small |

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
| small | entityGroupTypes constant x allowedEntityTypes (EntityType enum) | small |

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
| small | MqttQos enum (3 values) x excludeQos | small |

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
| small | SnmpSpecType enum values x used spec types | small |

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
| small | empty datasources x widget datasources (indexOf on same widget's few datasources) | small |

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
| small | chart series items x bar groups / bar items; few series per chart | small |

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
| small | chart series items x stack items; few series per chart | small |

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
| small | existing y-axis keys x found y-axis keys; a few axes | small |

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
| small | LocationKey available keys (enum) x used arguments | small |

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
| small | action key mappings x availableKeys (LocationKey enum) | small |

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
| small | threshold keys to remove x widget latestKeys; few keys | small |

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
| small | MailTemplate enum keys x settings keys | small |

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
| small | selected jobs x workingTask constant status list | small |

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
| small | widget types page (pageSize 10) x excludeWidgetTypeIds; page-capped | small |

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
| small | targets x healthFilter (few health values) | small |

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
| true | all scrape pool names x accordion open values; both scale with pool count | true |

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
| small | issue sidebar initial vs changed selections on one issue; each iteration awaits a POST (unsure) | small |

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
| small | issue sidebar changed vs initial selections on one issue; each iteration awaits a POST (unsure) | small |


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
| small | arg names x geofencingArgNames list; calculated-field args are a few | small |

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
| small | arg names x geofencingArgNames list; calculated-field args are a few | small |

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
| small | CF arguments x removedTelemetryKeys list; a few args/keys | small |

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
| true | entity inputs x relatedEntities List.contains; aggregation over related entities can be many | true |

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
| small | fixed LEGACY_SOLUTION_TEMPLATES map x alreadyInstalled list; one-off migration | small |

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
| small | fixed LEGACY_SOLUTION_TEMPLATES map x alreadyInstalled list; one-off migration | small |

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
| small | user's current entity groups x addedEntityGroups list; a handful of groups | small |

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
| small | latest values x subKeys list; subscription keys are widget-configured, a few-dozen | small |

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
| small | fixed GROUP_ENTITIES x entityTypes list (enum-sized) | small |

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
| small | repeatOn days-of-week list, at most 7 | small |

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
| true | generic diffLists; used by TbSqlBlockingQueue on batch lists (batch size can be 1000s) | true |

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
| small | services list per partition: a few cluster nodes | small |

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
| small | indexOf over chart y-axis settings; a few axes | small |

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
| small | indexOf over chart y-axis settings; a few axes | small |

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
| small | seriesList x allBarsList.indexOf; series per report chart are config-sized | small |

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
| small | indexOf over table columns; config-sized | small |

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
| small | fallback fonts list; a few font descriptions | small |

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
| small | content formats x 2 desired formats | small |

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
| small | client observations x objectIds; small per-device lists | small |

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
| small | connected chains x edgeRuleChainIds list; rule chains per edge are typically few | small |

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
| small | integration config attribute keys x fetched keys; config-sized | small |

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
| true | existing assignees x newAssignToList List.contains; assignee lists can be many entities | true |

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
| true | new assignees x existingEntityIds List.contains; data-derived | true |

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
| true | nodes.indexOf per node: O(n^2) in rule-chain node count (can be hundreds) | true |

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
| true | nodes.indexOf per saved node: O(n^2) in rule-chain node count | true |

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
| true | ruleNodes.indexOf per node when loading metadata: O(n^2) in node count | true |

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
| small | filter mappings x selectionMapping list: query keys, config-sized | small |

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
| small | filter mappings x selectionMapping list: query keys, config-sized | small |

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
| small | queries x entity view timeseries keys list; config-sized | small |

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
| small | configured keys x existing key list; config-sized | small |


## `bpm-perf-java-db-call-in-loop`

### #1256 · thingsboard/thingsboard@7a53801216 · `application/src/main/java/org/thingsboard/server/service/edqs/EdqsSyncService.java:154`

```
152:         UUID lastId = UUID.fromString("00000000-0000-0000-0000-000000000000");
153:         while (true) {
154:             var batch = entityGroupDao.findNextBatch(lastId, entityBatchSize);
155:             if (batch.isEmpty()) {
156:                 break;
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | keyset pagination: next batch depends on lastId of previous batch | wrong |

### #1257 · thingsboard/thingsboard@7a53801216 · `application/src/main/java/org/thingsboard/server/service/edqs/EdqsSyncService.java:184`

```
182: 
183:         while (true) {
184:             List<RelationEntity> batch = relationRepository.findNextBatch(lastFromEntityId, lastFromEntityType, lastRelationTypeGroup,
185:                     lastRelationType, lastToEntityId, lastToEntityType, entityBatchSize);
186:             if (batch.isEmpty()) {
187:                 break;
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | keyset pagination over relations; cursor from previous batch | wrong |

### #1258 · thingsboard/thingsboard@7a53801216 · `application/src/main/java/org/thingsboard/server/service/edqs/EdqsSyncService.java:238`

```
236: 
237:         while (true) {
238:             List<AttributeKvEntity> batch = attributesDao.findNextBatch(lastEntityId, lastAttributeType, lastAttributeKey, tsBatchSize);
239:             if (batch.isEmpty()) {
240:                 break;
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | keyset pagination over attributes; cursor from previous batch | wrong |

### #1260 · thingsboard/thingsboard@7a53801216 · `application/src/main/java/org/thingsboard/server/service/housekeeper/processor/EntitiesCleanupTaskProcessor.java:72`

```
70:         UUID last = null;
71:         while (true) {
72:             List<TbPair<UUID, UUID>> pairs = entityDao.findIdsByTenantProfileIdAndIdOffsetAndExpired(tenantProfileId, last, 128, ttl);
73: 
74:             if (pairs.isEmpty()) {
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | keyset pagination of expired ids, 128 per page; cursor driven | wrong |

### #1261 · thingsboard/thingsboard@7a53801216 · `application/src/main/java/org/thingsboard/server/service/housekeeper/processor/TenantEntitiesDeletionTaskProcessor.java:34`

```
32:         UUID last = null;
33:         while (true) {
34:             List<UUID> entities = entityDao.findIdsByTenantIdAndIdOffset(tenantId, last, 128);
35:             if (entities.isEmpty()) {
36:                 break;
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | keyset pagination of tenant entity ids, 128 per page; cursor driven | wrong |

### #1265 · thingsboard/thingsboard@7a53801216 · `application/src/main/java/org/thingsboard/server/service/install/lts/V4_3_1_4Migration.java:137`

```
135:             UUID alarmCursor = cursorAlarmId;
136:             BackfillBatch batch = transactionTemplate.execute(status ->
137:                     jdbcTemplate.query(BACKFILL_BATCH_SQL, this::extractBatch, entityCursor, alarmCursor, batchSize));
138:             if (batch == null) {
139:                 break; // window empty -> the whole table has been walked
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | keyset-paginated backfill in self-committing batches; cursor driven | wrong |

### #1268 · thingsboard/thingsboard@7a53801216 · `application/src/main/java/org/thingsboard/server/service/install/update/ResourcesUpdater.java:240`

```
238:             E entity;
239:             try {
240:                 entity = dao.findById(TenantId.SYS_TENANT_ID, id.getId());
241:             } catch (Exception e) {
242:                 log.error("Failed to update {} images: error fetching {} by id [{}]: {}", type, type, id.getId(), StringUtils.abbreviate(e.toString(), 1000));
```

| Proposed | Reason | Brad |
|---|---|---|
| true | upgrade: dao.findById per entity id over all tenants' entities; ids could be fetched in batches | true |

### #1269 · thingsboard/thingsboard@7a53801216 · `application/src/main/java/org/thingsboard/server/service/install/update/ResourcesUpdater.java:248`

```
246:                 boolean updated = updater.apply(entity);
247:                 if (updated) {
248:                     dao.save(entity.getTenantId(), entity);
249:                     log.debug("[{}][{}] Updated {} images", entity.getTenantId(), entity.getName(), type);
250:                     updatedCount++;
```

| Proposed | Reason | Brad |
|---|---|---|
| true | upgrade: dao.save per updated entity across all tenants; one write per row, batchable | true |

### #1302 · thingsboard/thingsboard@7a53801216 · `dao/src/main/java/org/thingsboard/server/dao/alarm/BaseAlarmService.java:409`

```
407:         List<Long> alarmCounts = new ArrayList<>();
408:         for (AlarmFilter filter : filters) {
409:             long count = alarmDao.findAlarmCount(tenantId, query, filter);
410:             alarmCounts.add(count);
411:         }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | one count query per alarm filter from the request; filters are a few widget filters | small |

### #1303 · thingsboard/thingsboard@7a53801216 · `dao/src/main/java/org/thingsboard/server/dao/attributes/BaseAttributesService.java:119`

```
117:         List<ListenableFuture<Long>> futures = new ArrayList<>(attributes.size());
118:         for (AttributeKvEntry attribute : attributes) {
119:             ListenableFuture<Long> future = Futures.transform(attributesDao.save(tenantId, entityId, scope, attribute), version -> {
120:                 TenantId edqsTenantId = entityId.getEntityType() == EntityType.TENANT ? (TenantId) entityId : tenantId;
121:                 edqsService.onUpdate(edqsTenantId, ObjectType.ATTRIBUTE_KV, new AttributeKv(entityId, scope, attribute, version));
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | attributesDao.save enqueues into TbSqlBlockingQueue that batches inserts; not a query per item | wrong |

### #1308 · thingsboard/thingsboard@7a53801216 · `dao/src/main/java/org/thingsboard/server/dao/entity/BaseEntityService.java:444`

```
442:                             List.of(new EntityKey(EntityKeyType.ENTITY_FIELD, ModelConstants.NAME_PROPERTY)), Collections.emptyList(), Collections.emptyList());
443: 
444:                     entityQueryDao.findEntityDataByQuery(tenantId, customerId, userPermissions, query).getData().forEach(entityData -> {
445:                         EntityId entityId = entityData.getEntityId();
446:                         Optional.ofNullable(entityData.getLatest().get(EntityKeyType.ENTITY_FIELD))
```

| Proposed | Reason | Brad |
|---|---|---|
| small | one batched query per entity type among requested ids; few entity types | small |

### #1312 · thingsboard/thingsboard@7a53801216 · `dao/src/main/java/org/thingsboard/server/dao/resource/BaseImageService.java:330`

```
328:             imageContainerDaoMap.forEach((entityType, imageContainerDao) -> {
329:                 var entities = tenantId.isSysTenantId() ? imageContainerDao.findByImageLink(link, MAX_ENTITIES_TO_FIND) :
330:                         imageContainerDao.findByTenantAndImageLink(tenantId, link, MAX_ENTITIES_TO_FIND);
331:                 if (!entities.isEmpty()) {
332:                     affectedEntities.put(entityType.name(), entities);
```

| Proposed | Reason | Brad |
|---|---|---|
| small | one reference lookup per image container DAO type; fixed small map | small |

### #1313 · thingsboard/thingsboard@7a53801216 · `dao/src/main/java/org/thingsboard/server/dao/resource/BaseResourceService.java:389`

```
387:         resourceLinkContainerDaoMap.forEach((entityType, dao) -> {
388:             List<EntityInfo> entities = tenantId.isSysTenantId()
389:                     ? dao.findByResource(ref, MAX_ENTITIES_TO_FIND)
390:                     : dao.findByTenantIdAndResource(tenantId, ref, MAX_ENTITIES_TO_FIND);
391:             if (!entities.isEmpty()) {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | one reference lookup per resource container DAO type; fixed small map | small |

### #1316 · thingsboard/thingsboard@7a53801216 · `dao/src/main/java/org/thingsboard/server/dao/rule/BaseRuleChainService.java:302`

```
300: 
301:                 RuleChainDataValidator.validateRuleNode(node);
302:                 RuleNode savedNode = ruleNodeDao.save(tenantId, node);
303:                 relations.add(new EntityRelation(ruleChainMetaData.getRuleChainId(), savedNode.getId(),
304:                         EntityRelation.CONTAINS_TYPE, RelationTypeGroup.RULE_CHAIN));
```

| Proposed | Reason | Brad |
|---|---|---|
| true | ruleNodeDao.save per rule node of a saved chain; grows with chain size, could saveAll | true |

### #1318 · thingsboard/thingsboard@7a53801216 · `dao/src/main/java/org/thingsboard/server/dao/rule/BaseRuleChainService.java:353`

```
351:                     layout.remove("ruleChainNodeId");
352:                     targetNode.setAdditionalInfo(layout);
353:                     targetNode = ruleNodeDao.save(tenantId, targetNode);
354: 
355:                     EntityRelation sourceRuleChainToRuleNode = new EntityRelation();
```

| Proposed | Reason | Brad |
|---|---|---|
| small | save per rule-chain connection node; usually a few cross-chain links | small |

### #1320 · thingsboard/thingsboard@7a53801216 · `dao/src/main/java/org/thingsboard/server/dao/rule/BaseRuleChainService.java:504`

```
502:         List<RuleNode> ruleNodes = new ArrayList<>();
503:         for (EntityRelation relation : relations) {
504:             RuleNode ruleNode = ruleNodeDao.findById(tenantId, relation.getFrom().getId());
505:             if (ruleNode != null) {
506:                 ruleNodes.add(ruleNode);
```

| Proposed | Reason | Brad |
|---|---|---|
| true | ruleNodeDao.findById per referencing relation; findAllRuleNodeByIds exists for a batch | true |

### #1321 · thingsboard/thingsboard@7a53801216 · `dao/src/main/java/org/thingsboard/server/dao/rule/BaseRuleChainService.java:530`

```
528:         List<EntityRelation> relations = new ArrayList<>();
529:         for (List<RuleNodeId> batch : Lists.partition(ruleNodeIds, RULE_NODES_BATCH_SIZE)) {
530:             relations.addAll(relationDao.findAllByFromIds(tenantId, toUUIDs(batch), EntityType.RULE_NODE, RelationTypeGroup.RULE_NODE));
531:         }
532:         for (EntityRelation relation : removeDanglingRelations(tenantId, relations)) {
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | already batched: findAllByFromIds per partition of RULE_NODES_BATCH_SIZE | wrong |

### #1323 · thingsboard/thingsboard@7a53801216 · `dao/src/main/java/org/thingsboard/server/dao/rule/BaseRuleChainService.java:583`

```
581:         Map<UUID, RuleNode> ruleNodesById = new HashMap<>();
582:         for (List<UUID> batch : Lists.partition(new ArrayList<>(ruleNodeIds), RULE_NODES_BATCH_SIZE)) {
583:             for (RuleNode ruleNode : ruleNodeDao.findAllRuleNodeByIds(batch.stream().map(RuleNodeId::new).toList())) {
584:                 ruleNodesById.put(ruleNode.getId().getId(), ruleNode);
585:             }
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | already batched: findAllRuleNodeByIds per partition | wrong |

### #1324 · thingsboard/thingsboard@7a53801216 · `dao/src/main/java/org/thingsboard/server/dao/secret/SecretServiceImpl.java:184`

```
182:         String placeholder = String.format("${secret:%s;type:%s}", secretInfo.getName(), secretInfo.getType());
183:         hasSecretsEntityDaos.forEach((entityType, hasSecretsEntityDao) -> {
184:             var entities = hasSecretsEntityDao.findByTenantIdAndSecretPlaceholder(tenantId, placeholder);
185:             if (!entities.isEmpty()) {
186:                 affectedEntities.put(entityType, entities);
```

| Proposed | Reason | Brad |
|---|---|---|
| small | one placeholder lookup per secret-holding DAO type; fixed small map | small |

### #1326 · thingsboard/thingsboard@7a53801216 · `dao/src/main/java/org/thingsboard/server/dao/sql/attributes/JpaAttributeDao.java:341`

```
339:         for (String key : keys) {
340:             futuresList.add(service.submit(() -> {
341:                 attributeKvRepository.delete(entityId.getId(), attributeScope.getId(), keyDictionaryDao.getOrSaveKeyId(key));
342:                 return key;
343:             }));
```

| Proposed | Reason | Brad |
|---|---|---|
| true | per attribute key from request, a DELETE query submitted per key; one batched delete by key list would do | true |

### #1327 · thingsboard/thingsboard@7a53801216 · `dao/src/main/java/org/thingsboard/server/dao/sql/attributes/JpaAttributeDao.java:359`

```
357:                             entityId.getId(), attributeScope.getId(), keyDictionaryDao.getOrSaveKeyId(key));
358:                 } else {
359:                     version = transactionTemplate.execute(status -> jdbcTemplate.query(removeWithVersionQuery,
360:                             rs -> rs.next() ? rs.getObject(1, Long.class) : null, entityId.getId(), attributeScope.getId(), keyDictionaryDao.getOrSaveKeyId(key)));
361:                 }
362:                 return TbPair.of(key, version);
```

| Proposed | Reason | Brad |
|---|---|---|
| true | per attribute key, a delete-returning-version query per key; batchable with one DELETE ... RETURNING over the key list | true |

### #1328 · thingsboard/thingsboard@7a53801216 · `dao/src/main/java/org/thingsboard/server/dao/sql/blob/JpaBlobEntityDao.java:84`

```
82:             var endTime = startTime + partitionStepInMs;
83:             log.info("Migrating blob entities for time period: {} - {}", startTime, endTime);
84:             jdbcTemplate.update("CALL migrate_blob_entities(?, ?, ?)", startTime, endTime, partitionStepInMs);
85:             startTime = endTime;
86:         }
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | while loop over time partitions calling migrate procedure per window; deliberate chunked one-off migration | wrong |

### #1329 · thingsboard/thingsboard@7a53801216 · `dao/src/main/java/org/thingsboard/server/dao/sql/citus/DefaultCitusSchemaService.java:408`

```
406:             // NULL, so it cannot be mapped to Void.class. We use execute(...) and inline the table
407:             // name — it is a trusted internal constant from CitusTables, never user input.
408:             jdbcTemplate.execute("SELECT create_reference_table('" + table + "')");
409:         }
410:     }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | loops fixed internal list of Citus reference tables, one DDL call each at schema conversion | small |

### #1332 · thingsboard/thingsboard@7a53801216 · `dao/src/main/java/org/thingsboard/server/dao/sql/citus/DefaultCitusSchemaService.java:542`

```
540:             log.warn("Re-adding managed foreign key {} missing after a crash during a prior run's FK re-add: {}",
541:                     fk.name(), addStatement);
542:             jdbcTemplate.execute(addStatement);
543:         }
544:     }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | loops static catalog of managed foreign keys, re-adding missing ones via DDL; fixed small set | small |

### #1334 · thingsboard/thingsboard@7a53801216 · `dao/src/main/java/org/thingsboard/server/dao/sql/citus/DefaultCitusSchemaService.java:633`

```
631:             log.info("Dropping distribution-incompatible unique constraint {} on {} " +
632:                     "(enforced at application layer)", name, table);
633:             jdbcTemplate.execute("ALTER TABLE " + table + " DROP CONSTRAINT " + name);
634:         }
635:     }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | loops unique constraints of one table, one ALTER TABLE DROP each; a handful of DDL statements | small |

### #1337 · thingsboard/thingsboard@7a53801216 · `dao/src/main/java/org/thingsboard/server/dao/sql/query/DefaultEntityQueryRepository.java:2506`

```
2504:         String sql = "select id, tenant_id, customer_id, created_time, name, type, " + labelColumn +
2505:                 ", additional_info from " + table + " where id in (select unnest(" + idsParam + "))";
2506:         for (Map<String, Object> row : jdbcTemplate.queryForList(sql, prefetchCtx)) {
2507:             out.put((UUID) row.get("id"), row);
2508:         }
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | iterates rows of a single queryForList result; the query runs once, not per iteration | wrong |

### #1341 · thingsboard/thingsboard@7a53801216 · `dao/src/main/java/org/thingsboard/server/dao/timeseries/BaseTimeseriesService.java:129`

```
127:         keys.forEach(key -> Validator.validateString(key, k -> "Incorrect key " + k));
128:         for (String key : keys) {
129:             futures.add(timeseriesLatestDao.findLatest(tenantId, entityId, key));
130:         }
131:         return Futures.allAsList(futures);
```

| Proposed | Reason | Brad |
|---|---|---|
| true | per telemetry key, findLatest issues a cache/DB lookup per key; a multi-key latest query would batch it | true |

### #1342 · thingsboard/thingsboard@7a53801216 · `dao/src/main/java/org/thingsboard/server/dao/timeseries/BaseTimeseriesService.java:210`

```
208:             if (saveTs) {
209:                 tsFutures.add(timeseriesDao.savePartition(tenantId, entityId, tsKvEntry.getTs(), tsKvEntry.getKey()));
210:                 tsFutures.add(timeseriesDao.save(tenantId, entityId, tsKvEntry, ttl, overwriteValue));
211:             }
212:             if (saveLatest) {
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | per ts entry, timeseriesDao.save only enqueues into tsQueue which batches inserts; no per-row query | wrong |

### #1343 · thingsboard/thingsboard@7a53801216 · `dao/src/main/java/org/thingsboard/server/dao/user/UserServiceImpl.java:662`

```
660:     @Override
661:     public void removeMobileSession(TenantId tenantId, String mobileToken) {
662:         for (UserSettings userSettings : userSettingsDao.findByTypeAndPath(tenantId, UserSettingsType.MOBILE, "sessions", mobileToken)) {
663:             ((ObjectNode) userSettings.getSettings().get("sessions")).remove(mobileToken);
664:             userSettingsService.saveUserSettings(tenantId, userSettings);
```

| Proposed | Reason | Brad |
|---|---|---|
| small | loops user settings matching one mobile token (normally 0-1 rows), saving each | small |

### #1353 · thingsboard/thingsboard@7a53801216 · `migrator/src/main/java/org/thingsboard/migrator/service/tenant/exporting/PostgresTenantDataExporter.java:179`

```
177:             String batchQuery = query + " LIMIT " + batchSize + " OFFSET " + offset;
178: 
179:             List<Map<String, Object>> rows = jdbcTemplate.queryForList(batchQuery, queryParams);
180:             rows.forEach(rowProcessor);
181:             batchIndex++;
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | LIMIT/OFFSET pagination loop, one query per page by design; sequential paging is inherent | wrong |


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
| small | existing CFs x imported CFs of one entity; a few calculated fields per entity | small |

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
| small | imported CFs x existing CFs of one entity; a few | small |

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
| small | existing x imported permissions of one user group; typically a handful | small |

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
| small | OTA packages of one group, keyed by package type (firmware/software) | small |

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
| small | y-axes x datasetKeys of one chart: config-sized | small |

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
| small | per-ts entries x dataKeys: entries per timestamp equal key count (a few) | small |

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
| small | bootstrap config servers: a few LwM2M servers | small |

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
| true | imported dashboards x tenant persistentDashboards by title; tenant data-derived | true |

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
| small | message attributes x entity view key list; config-sized | small |

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
| small | message attributes x entity view key list; config-sized | small |

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
| wrong | per-mapping filter by TBEL predicate over children, not a key join; Map can't replace it | wrong |


## `bpm-perf-java-regex-compile-in-loop`

### #1370 · thingsboard/thingsboard@7a53801216 · `rule-engine/rule-engine-components/src/main/java/org/thingsboard/rule/engine/pe/twilio/TbTwilioSmsNode.java:106`

```
104:                         new PhoneNumber(numberTo.trim()),
105:                         new PhoneNumber(numberFrom.trim()),
106:                         msg.getData().replaceAll("^\"|\"$", "").replaceAll("\\\\n", "\n")
107:                 ).create(this.twilioRestClient);
108:                 log.trace("[{}][{}][{}] Sms for number: {} sent successfully!", ctx.getTenantId().getId(), ctx.getSelfId().getId(), msg.getId(), numbersTo);
```

| Proposed | Reason | Brad |
|---|---|---|
| small | replaceAll regex on msg data per destination phone number; numbersTo is a short config list | small |


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
| small | hierarchy.add(0) per superclass; class hierarchy depth is a few | small |

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
| wrong | single add(0) per entity's list, not repeated into one growing list | wrong |


## `bpm-perf-java-string-concat-in-loop`

### #1253 · thingsboard/thingsboard@7a53801216 · `application/src/main/java/org/thingsboard/server/controller/NotificationController.java:574`

```
572:                     } else if (recipient instanceof User) {
573:                         if (!title.equals(recipient.getEmail())) {
574:                             title += " (" + recipient.getEmail() + ")";
575:                         }
576:                     }
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | title += is a fresh per-recipient string, not accumulated across iterations; no quadratic build | wrong |

### #1280 · thingsboard/thingsboard@7a53801216 · `common/integration/http-integrations/src/main/java/org/thingsboard/integration/http/thingpark/ThingParkIntegration.java:137`

```
135:                     String params = DEV_EUI + "=" + metadata.get(DEV_EUI) + "&" + F_PORT + "=" + metadata.get(F_PORT) + "&" + PAYLOAD + "=" + payload;
136:                     if (metadata.containsKey(F_CNT_DN)) {
137:                         params += "&" + F_CNT_DN + "=" + metadata.get(F_CNT_DN);
138:                     }
139:                     if (metadata.containsKey(CONFIRMED)) {
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | params is a fresh per-downlink string with a few fixed appends; nothing accumulates across iterations | wrong |

### #1281 · thingsboard/thingsboard@7a53801216 · `common/integration/http-integrations/src/main/java/org/thingsboard/integration/http/thingpark/ThingParkIntegration.java:140`

```
138:                     }
139:                     if (metadata.containsKey(CONFIRMED)) {
140:                         params += "&" + CONFIRMED + "=" + metadata.get(CONFIRMED);
141:                     }
142:                     if (metadata.containsKey(FLUSH_DOWNLINK_QUEUE)) {
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | params is a fresh per-downlink string with a few fixed appends; nothing accumulates across iterations | wrong |

### #1282 · thingsboard/thingsboard@7a53801216 · `common/integration/http-integrations/src/main/java/org/thingsboard/integration/http/thingpark/ThingParkIntegration.java:143`

```
141:                     }
142:                     if (metadata.containsKey(FLUSH_DOWNLINK_QUEUE)) {
143:                         params += "&" + FLUSH_DOWNLINK_QUEUE + "=" + metadata.get(FLUSH_DOWNLINK_QUEUE);
144:                     }
145:                     if (securityEnabled) {
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | params is a fresh per-downlink string with a few fixed appends; nothing accumulates across iterations | wrong |

### #1283 · thingsboard/thingsboard@7a53801216 · `common/integration/http-integrations/src/main/java/org/thingsboard/integration/http/thingpark/ThingParkIntegration.java:146`

```
144:                     }
145:                     if (securityEnabled) {
146:                         params += "&AS_ID=" + securityAsId;
147:                         params += "&Time=" + ISO8601.get().format(new Date());
148:                         String token = getToken(params + securityAsKey);
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | params is a fresh per-downlink string with a few fixed appends; nothing accumulates across iterations | wrong |

### #1284 · thingsboard/thingsboard@7a53801216 · `common/integration/http-integrations/src/main/java/org/thingsboard/integration/http/thingpark/ThingParkIntegration.java:147`

```
145:                     if (securityEnabled) {
146:                         params += "&AS_ID=" + securityAsId;
147:                         params += "&Time=" + ISO8601.get().format(new Date());
148:                         String token = getToken(params + securityAsKey);
149:                         params += "&Token=" + token;
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | params is a fresh per-downlink string with a few fixed appends; nothing accumulates across iterations | wrong |

### #1285 · thingsboard/thingsboard@7a53801216 · `common/integration/http-integrations/src/main/java/org/thingsboard/integration/http/thingpark/ThingParkIntegration.java:149`

```
147:                         params += "&Time=" + ISO8601.get().format(new Date());
148:                         String token = getToken(params + securityAsKey);
149:                         params += "&Token=" + token;
150:                     }
151: 
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | params is a fresh per-downlink string with a few fixed appends; nothing accumulates across iterations | wrong |

### #1287 · thingsboard/thingsboard@7a53801216 · `common/report/src/main/java/org/thingsboard/server/report/context/chart/TsChartDataSource.java:93`

```
91:                 } else {
92:                     String label = key.getLabel();
93:                     label += " " + labelSuffixForComparisonUnit(timeForComparison);
94:                     key.setLabel(label);
95:                 }
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | label is a fresh per-data-key string with one suffix append; no accumulation across iterations | wrong |

### #1301 · thingsboard/thingsboard@7a53801216 · `common/transport/lwm2m/src/main/java/org/thingsboard/server/transport/lwm2m/server/uplink/DefaultLwM2mUplinkMsgHandler.java:707`

```
705:         String targetIdSearch = targetIdParts[0];
706:         for (int i = 1; i < targetIdParts.length; i++) {
707:             targetIdSearch += "/" + targetIdParts[i];
708:             if (supportedIds.contains(targetIdSearch)) {
709:                 return true;
```

| Proposed | Reason | Brad |
|---|---|---|
| small | accumulates LwM2M path segments (3-4 parts) into targetIdSearch; tiny bounded loop | small |

### #1338 · thingsboard/thingsboard@7a53801216 · `dao/src/main/java/org/thingsboard/server/dao/sql/query/DefaultQueryLogComponent.java:70`

```
68: 
69:                 if (count > 0) {
70:                     valueArrayStr+=", ";
71:                 }
72: 
```

| Proposed | Reason | Brad |
|---|---|---|
| true | builds IN-list value string with += over an Iterable SQL param (can be thousands of ids) for query log | true |

### #1339 · thingsboard/thingsboard@7a53801216 · `dao/src/main/java/org/thingsboard/server/dao/sql/query/DefaultQueryLogComponent.java:74`

```
72: 
73:                 String valueForSQLQuery = getValueForSQLQuery(valueTemp);
74:                 valueArrayStr += valueForSQLQuery;
75:                 ++count;
76:             }
```

| Proposed | Reason | Brad |
|---|---|---|
| true | appends each value of an Iterable SQL param via +=; quadratic for large id lists; use StringJoiner | true |

### #1344 · thingsboard/thingsboard@7a53801216 · `migrator/src/main/java/org/thingsboard/migrator/service/latest_kv/importing/PostgresLatestKvImporter.java:66`

```
64: 
65:             if (!columnsStatement.isEmpty()) {
66:                 columnsStatement += ",";
67:             }
68:             columnsStatement += column;
```

| Proposed | Reason | Brad |
|---|---|---|
| small | += over columns of one row (fixed schema, ~10 columns) to build INSERT | small |

### #1345 · thingsboard/thingsboard@7a53801216 · `migrator/src/main/java/org/thingsboard/migrator/service/latest_kv/importing/PostgresLatestKvImporter.java:68`

```
66:                 columnsStatement += ",";
67:             }
68:             columnsStatement += column;
69: 
70:             if (!valuesStatement.isEmpty()) {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | += over columns of one row (fixed schema, ~10 columns) to build INSERT | small |

### #1346 · thingsboard/thingsboard@7a53801216 · `migrator/src/main/java/org/thingsboard/migrator/service/latest_kv/importing/PostgresLatestKvImporter.java:71`

```
69: 
70:             if (!valuesStatement.isEmpty()) {
71:                 valuesStatement += ",";
72:             }
73:             valuesStatement += "?";
```

| Proposed | Reason | Brad |
|---|---|---|
| small | += over columns of one row (fixed schema, ~10 columns) to build INSERT | small |

### #1347 · thingsboard/thingsboard@7a53801216 · `migrator/src/main/java/org/thingsboard/migrator/service/latest_kv/importing/PostgresLatestKvImporter.java:73`

```
71:                 valuesStatement += ",";
72:             }
73:             valuesStatement += "?";
74:             if (value instanceof JsonNode) {
75:                 entry.setValue(value.toString());
```

| Proposed | Reason | Brad |
|---|---|---|
| small | += over columns of one row (fixed schema, ~10 columns) to build INSERT | small |

### #1348 · thingsboard/thingsboard@7a53801216 · `migrator/src/main/java/org/thingsboard/migrator/service/latest_kv/importing/PostgresLatestKvImporter.java:78`

```
76:             }
77:             String valueType = columns.get(column);
78:             valuesStatement += "::" + valueType;
79:         }
80: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | += over columns of one row (fixed schema, ~10 columns) to build INSERT | small |

### #1349 · thingsboard/thingsboard@7a53801216 · `migrator/src/main/java/org/thingsboard/migrator/service/tenant/exporting/PostgresTenantDataExporter.java:95`

```
93:             for (Table referencedTable : referencedTables) {
94:                 if (referencedTable.getReference() == null) {
95:                     query += format(" %s IN (SELECT %s.id FROM %s WHERE %s.%s = '%s') OR",
96:                             referencingColumn, referencedTable.getName(), referencedTable.getName(),
97:                             referencedTable.getName(), referencedTable.getTenantIdColumn(), tenantId);
98:                 } else {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | += over referenced tables of a fixed schema enum to build export WHERE; a few iterations | small |

### #1350 · thingsboard/thingsboard@7a53801216 · `migrator/src/main/java/org/thingsboard/migrator/service/tenant/exporting/PostgresTenantDataExporter.java:103`

```
101:                     List<Table> tables = anotherReference.getValue();
102:                     for (Table anotherReferencedTable : tables) {
103:                         query += format(" %s IN (SELECT %s.id FROM %s INNER JOIN %s ON %s.%s = %s.id WHERE %s.%s = '%s') OR",
104:                                 referencingColumn, referencedTable.getName(), referencedTable.getName(),
105:                                 anotherReferencedTable.getName(), referencedTable.getName(), column, anotherReferencedTable.getName(),
106:                                 anotherReferencedTable.getName(), anotherReferencedTable.getTenantIdColumn(), tenantId);
```

| Proposed | Reason | Brad |
|---|---|---|
| small | += over nested referenced tables of a fixed schema enum; a few iterations | small |

### #1351 · thingsboard/thingsboard@7a53801216 · `migrator/src/main/java/org/thingsboard/migrator/service/tenant/exporting/PostgresTenantDataExporter.java:143`

```
141:                     }
142:                     relatedQuery = format(insertAfter(relatedQuery, "SELECT", " '%s' as table_name, "), table.toString());
143:                     relatedQuery += format("%s = '%s'", relatedTable.getReference().getKey(), row.get("id"));
144:                     relatedQuery += " ORDER BY " + String.join(", ", relatedTable.getSortColumns());
145:                     queryAndSave(relatedTable, relatedQuery);
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | relatedQuery is a fresh string per related table with fixed appends; no accumulation | wrong |

### #1352 · thingsboard/thingsboard@7a53801216 · `migrator/src/main/java/org/thingsboard/migrator/service/tenant/exporting/PostgresTenantDataExporter.java:144`

```
142:                     relatedQuery = format(insertAfter(relatedQuery, "SELECT", " '%s' as table_name, "), table.toString());
143:                     relatedQuery += format("%s = '%s'", relatedTable.getReference().getKey(), row.get("id"));
144:                     relatedQuery += " ORDER BY " + String.join(", ", relatedTable.getSortColumns());
145:                     queryAndSave(relatedTable, relatedQuery);
146:                 }
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | relatedQuery is a fresh string per related table with fixed appends; no accumulation | wrong |

### #1354 · thingsboard/thingsboard@7a53801216 · `migrator/src/main/java/org/thingsboard/migrator/service/tenant/importing/PostgresTenantDataImporter.java:98`

```
96: 
97:             if (!columnsStatement.isEmpty()) {
98:                 columnsStatement += ",";
99:             }
100:             columnsStatement += column;
```

| Proposed | Reason | Brad |
|---|---|---|
| small | += over columns of one row (fixed table schema) to build INSERT | small |

### #1355 · thingsboard/thingsboard@7a53801216 · `migrator/src/main/java/org/thingsboard/migrator/service/tenant/importing/PostgresTenantDataImporter.java:100`

```
98:                 columnsStatement += ",";
99:             }
100:             columnsStatement += column;
101: 
102:             if (!valuesStatement.isEmpty()) {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | += over columns of one row (fixed table schema) to build INSERT | small |

### #1356 · thingsboard/thingsboard@7a53801216 · `migrator/src/main/java/org/thingsboard/migrator/service/tenant/importing/PostgresTenantDataImporter.java:103`

```
101: 
102:             if (!valuesStatement.isEmpty()) {
103:                 valuesStatement += ",";
104:             }
105:             valuesStatement += "?";
```

| Proposed | Reason | Brad |
|---|---|---|
| small | += over columns of one row (fixed table schema) to build INSERT | small |

### #1357 · thingsboard/thingsboard@7a53801216 · `migrator/src/main/java/org/thingsboard/migrator/service/tenant/importing/PostgresTenantDataImporter.java:105`

```
103:                 valuesStatement += ",";
104:             }
105:             valuesStatement += "?";
106:             if (value instanceof JsonNode) {
107:                 entry.setValue(value.toString());
```

| Proposed | Reason | Brad |
|---|---|---|
| small | += over columns of one row (fixed table schema) to build INSERT | small |

### #1358 · thingsboard/thingsboard@7a53801216 · `migrator/src/main/java/org/thingsboard/migrator/service/tenant/importing/PostgresTenantDataImporter.java:117`

```
115:             }
116:             String valueType = columns.get(table).get(column);
117:             valuesStatement += "::" + valueType;
118:         }
119: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | += over columns of one row (fixed table schema) to build INSERT | small |


## `bpm-perf-json-deep-clone`

### #8 · excalidraw/excalidraw@b7de45e881 · `packages/common/src/utils.ts:948`

```
946: };
947: 
948: export const cloneJSON = <T>(obj: T): T => JSON.parse(JSON.stringify(obj));
949: 
950: export const updateStable = <T extends any[] | Record<string, any>>(
```

| Proposed | Reason | Brad |
|---|---|---|
| true | cloneJSON utility used on whole scene elements/appState (collab sync, export); large objects, structuredClone fits | true |

### #81 · outline/outline@670410b236 · `app/models/base/Model.ts:65`

```
63:   ): PartialExcept<T, "id"> {
64:     const fields = getFieldsForModelClass(this);
65:     return JSON.parse(JSON.stringify(pick(record, ["id", ...fields])));
66:   }
67: 
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | JSON round-trip intentionally strips to plain serialisable data from MobX model; structuredClone fails on proxies | wrong |

### #83 · outline/outline@670410b236 · `app/models/base/Model.ts:305`

```
303:    */
304:   toPersisted = (): PartialExcept<Model, "id"> =>
305:     JSON.parse(JSON.stringify({ ...this.toAPI(), id: this.id }));
306: 
307:   /**
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | toPersisted JSON round-trip deliberately serialises MobX observables to plain data; JSON semantics required | wrong |

### #133 · outline/outline@670410b236 · `server/commands/documentCollaborativeUpdater.ts:56`

```
54:   // round-trip additionally drops undefined-valued attrs, which are absent
55:   // from previously stored content but present on `Node.toJSON` output.
56:   const content = JSON.parse(
57:     JSON.stringify(
58:       Node.fromJSON(schema, yDocToProsemirrorJSON(ydoc, "default")).toJSON()
59:     )
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | JSON round-trip deliberately canonicalises ProseMirror JSON (drops undefined attrs); not a clone | wrong |

### #1422 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/profile/device/lwm2m/lwm2m-device-profile-transport-configuration.component.ts:416`

```
414: 
415:   private validateKeyNameObjects = (nameJson: object, attributeArray: string[], telemetryArray: string[]): object => {
416:     const keyName = JSON.parse(JSON.stringify(nameJson));
417:     const keyNameValidate = {};
418:     const keyAttrTelemetry = attributeArray.concat(telemetryArray);
```

| Proposed | Reason | Brad |
|---|---|---|
| small | clones small LwM2M keyName config object once per form update; tiny UI config | small |

### #1423 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/profile/device/lwm2m/lwm2m-device-profile-transport-configuration.component.ts:435`

```
433:     const observeStrategyValue = this.lwm2mDeviceProfileFormGroup.get('observeStrategy').value;
434:     const initAttrTelAsObsStrategyValue = this.lwm2mDeviceProfileFormGroup.get('initAttrTelAsObsStrategy').value;
435:     const observeJson: ObjectLwM2M[] = JSON.parse(JSON.stringify(val));
436:     observeJson.forEach(obj => {
437:       if (isDefinedAndNotNull(obj.attributes) && !isEmpty(obj.attributes)) {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | clones small LwM2M object list once per form update; tiny UI config | small |


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
| small | serverUrls x auth cookies x cookie store: few server URLs, a couple of auth cookies | small |

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
| small | included ids x allCategories: user library categories, typically tens | small |

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
| small | excluded ids x allCategories: user library categories, typically tens | small |

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
| small | included ids x allCategories: user categories, typically tens | small |

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
| small | excluded ids x allCategories: user categories, typically tens | small |

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
| small | included ids x allCategories: user categories, typically tens | small |

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
| small | excluded ids x allCategories: user categories, typically tens | small |

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
| true | target chapters x prevMangaChapters.find: manga can have 1000+ chapters | true |


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
| small | saleor permission list x required perms list: bounded set of ~tens of permission codenames | small |

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
| true | checkout lines x updated_lines_ids list; line counts are data-derived (size unknown, could be large) | true |

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
| true | lines_info x affected_line_ids list; order lines are data-derived | true |

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
| true | rules x gift_rules list; promotion rules are merchant data, size unknown | true |

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
| true | lines_info x discounted_lines list (LineInfo equality scan); checkout lines data-derived | true |

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
| small | orders x accessible_channels; channel count per shop is a handful | small |

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
| small | lines_input x existing gift line ids; gift lines per checkout are a handful | small |

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
| small | country_rates x updated_countries; bounded by ~250 countries | small |

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
| small | countries_configuration x updated_countries; bounded by ~250 countries | small |

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
| true | pks (request ids) x nodes_pk_list, plus pks.index in sort; grows with requested id count | true |

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
| true | variants x variants_ids list from checkout lines; data-derived | true |

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
| true | variants x variants_ids list from checkout lines; data-derived | true |

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
| small | membership in 2-element record-name list | small |

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
| true | every .py file checked against pyi_files list; file counts grow with repo (dev tool) | true |

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
| true | stream_ids x web_public_stream_ids list; realm stream counts can be large | true |

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
| true | realm members x full_member_group_user_ids list; user counts grow with realm | true |

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
| small | membership in fixed 2-element list ['phone','skype'] | small |

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
| small | membership in fixed 2-element list ['general','random'] | small |

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
| small | membership in fixed 1-element unsupported_is_operands list | small |

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
| true | request-supplied subgroup ids x group_ids_found list; size is request-derived | true |

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
| true | request-supplied direct_subgroups x group_ids_found list; request-derived | true |

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
| small | thumbnail formats of one image x its found thumbnails: a few formats | small |

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
| small | kwargs keys x fixed ~15-name allowlist | small |

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
| small | registrations x tokens_to_deduplicate for one user/kind: a few devices | small |

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
| true | remote realms of server x reported_uuids list; realm count per server data-derived | true |

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
| true | remote realms of server x reported_uuids list (not in); same as above | true |

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
| true | inside loop over remote realms, uuid in reported_uuids list | true |

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
| small | a document's doc-link custom fields x incoming field ids: a handful | small |


## `bpm-perf-orm-call-in-loop`

### #80 · outline/outline@670410b236 · `app/models/base/Model.ts:38`

```
36:     );
37:     if (symbol) {
38:       const annotations: Record<string | symbol, unknown> = Reflect.get(
39:         prototype,
40:         symbol
41:       );
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | Reflect.get on a prototype symbol walking the prototype chain; not a DB call | wrong |

### #150 · outline/outline@670410b236 · `server/commands/groupsSyncer.ts:80`

```
78:         updates.name = eg.name;
79:       }
80:       await externalGroup.update(updates, { transaction });
81: 
82:       // Keep the linked internal Group's name and description in sync
```

| Proposed | Reason | Brad |
|---|---|---|
| true | per external IdP group, findOrCreate + update queries in a loop; groups per user grow, could bulk upsert | true |

### #153 · outline/outline@670410b236 · `server/commands/groupsSyncer.ts:106`

```
104:           }
105:           if (Object.keys(groupUpdates).length > 0) {
106:             await group.update(groupUpdates, { transaction });
107:           }
108:         }
```

| Proposed | Reason | Brad |
|---|---|---|
| true | per external group, Group.findByPk + update inside loop; N+1 on group sync | true |

### #156 · outline/outline@670410b236 · `server/commands/groupsSyncer.ts:121`

```
119:         createdById: user.id,
120:       });
121:       await externalGroup.update({ groupId: group.id }, { transaction });
122:       externalGroup.groupId = group.id;
123:       result.groupsCreated++;
```

| Proposed | Reason | Brad |
|---|---|---|
| true | per external group, create Group then update ExternalGroup; per-row writes in group sync loop | true |

### #240 · outline/outline@670410b236 · `server/queues/processors/ImportsProcessor.ts:585`

```
583: 
584:             // Update document id for attachments in document content.
585:             await Attachment.update(
586:               { documentId: internalId },
587:               { where: { documentId: externalId }, silent: true, transaction }
588:             );
```

| Proposed | Reason | Brad |
|---|---|---|
| true | per imported document, Attachment.update by documentId; grows with import size, batchable | true |

### #342 · outline/outline@670410b236 · `server/queues/tasks/UpdateDocumentsPopularityScoreTask.ts:509`

```
507:         if (timestamp < cutoff) {
508:           Logger.info("task", `Dropping stale working table: ${tablename}`);
509:           await sequelize.query(`DROP TABLE IF EXISTS "${tablename}" CASCADE`);
510:         }
511:       }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | drops stale working tables found by prefix; a few tables per cleanup run | small |

### #404 · outline/outline@670410b236 · `shared/editor/nodes/ToggleBlock.ts:608`

```
606:     // Insert from the end so earlier positions stay valid.
607:     for (const { node, pos } of emptyBlocks.reverse()) {
608:       tr.insert(
609:         pos + 1 + node.content.size,
610:         state.schema.nodes.paragraph.create({})
611:       );
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | ProseMirror tr.insert into a transaction; not a DB call | wrong |

### #416 · immich-app/immich@f7b8ae5da3 · `packages/cli/src/commands/asset.ts:499`

```
497:         }),
498:       );
499:       deletionProgress.update(assetBatch.length);
500:     }
501:   };
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | progress bar update() in CLI delete loop; not a DB call | wrong |

### #437 · immich-app/immich@f7b8ae5da3 · `server/src/repositories/event.repository.ts:188`

```
186:         }
187: 
188:         const event = reflector.get<EventConfig>(MetadataKey.EventConfig, handler);
189:         if (!event) {
190:           continue;
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | Nest reflector.get metadata lookup at startup; not a DB call | wrong |

### #453 · immich-app/immich@f7b8ae5da3 · `server/src/repositories/telemetry.repository.ts:136`

```
134: 
135:     for (const Repository of repositories) {
136:       const isEnabled = this.reflect.get(MetadataKey.TelemetryEnabled, Repository) ?? true;
137:       if (!isEnabled) {
138:         this.logger.debug(`Telemetry disabled for ${Repository.name}`);
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | Reflect metadata lookup over repository classes at setup; not a DB call | wrong |

### #460 · immich-app/immich@f7b8ae5da3 · `server/src/services/album.service.ts:240`

```
238:         albumAssetValues.push({ albumId, assetId });
239:       }
240:       await this.albumRepository.update(
241:         albumId,
242:         {
243:           id: albumId,
```

| Proposed | Reason | Brad |
|---|---|---|
| true | per album id in request: getAssetIds, findOrFail and update queries each; N+1 over albums | true |

### #507 · immich-app/immich@f7b8ae5da3 · `server/src/services/media.service.ts:100`

```
98:           }
99: 
100:           await this.personRepository.update({ ownerId, personGroupId, faceAssetId: face.id });
101:         }
102: 
```

| Proposed | Reason | Brad |
|---|---|---|
| true | per person across all people: getRandomFace + update query; grows with library, batchable | true |

### #528 · immich-app/immich@f7b8ae5da3 · `server/src/services/person.service.ts:176`

```
174:       }
175: 
176:       await this.personRepository.update({ ownerId, personGroupId, faceAssetId: assetFace.id });
177:       jobs.push({ name: JobName.PersonGenerateThumbnail, data: { ownerId, personGroupId } });
178:     }
```

| Proposed | Reason | Brad |
|---|---|---|
| true | per person in changeFeaturePhoto list: getRandomFace + update per person | true |

### #530 · immich-app/immich@f7b8ae5da3 · `server/src/services/person.service.ts:303`

```
301:     for (const person of dto.people) {
302:       try {
303:         await this.update(auth, person.id, {
304:           isHidden: person.isHidden,
305:           name: person.name,
306:           birthDate: person.birthDate,
```

| Proposed | Reason | Brad |
|---|---|---|
| true | per person in bulk update request, full update() with access checks and queries per row | true |

### #536 · immich-app/immich@f7b8ae5da3 · `server/src/services/person.service.ts:724`

```
722:           );
723:           if (Object.keys(changes).length > 0) {
724:             target = await this.personRepository.update({ ownerId, personGroupId: targetId, ...changes });
725:             targets.set(ownerId, target);
726:           }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | merge loop over a few user-chosen source persons x owners; update per merge | small |

### #645 · immich-app/immich@f7b8ae5da3 · `server/src/utils/config.ts:88`

```
86:   const rawConfig = cloneDeep(defaults);
87:   for (const property of getKeysDeep(partial)) {
88:     set(rawConfig, property, get(partial, property));
89:   }
90: 
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | lodash set/get on config objects; not a DB call | wrong |

### #648 · immich-app/immich@f7b8ae5da3 · `server/src/utils/preferences.ts:66`

```
64:   const partial = item?.value || {};
65:   for (const property of getKeysDeep(partial)) {
66:     set(preferences, property, get(partial, property));
67:   }
68: 
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | lodash set/get on preferences object; not a DB call | wrong |

### #649 · immich-app/immich@f7b8ae5da3 · `server/src/utils/preferences.ts:76`

```
74:   const partial: DeepPartial<UserPreferences> = {};
75:   for (const property of getKeysDeep(defaultPreferences)) {
76:     const newValue = get(newPreferences, property);
77:     const isEmpty = [undefined, null, ''].includes(newValue);
78:     const defaultValue = get(defaultPreferences, property);
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | lodash get on preferences object; not a DB call | wrong |

### #655 · immich-app/immich@f7b8ae5da3 · `web/src/lib/actions/use-actions.ts:55`

```
53:           const actionEntry = actions[i];
54:           if (Array.isArray(actionEntry) && actionEntry.length > 1) {
55:             returnEntry.update(actionEntry[1]);
56:           } else {
57:             returnEntry.update();
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | Svelte action returnEntry.update(); not a DB call | wrong |

### #676 · immich-app/immich@f7b8ae5da3 · `web/src/lib/workers/hash-file.ts:16`

```
14:     const buffer = await slice.arrayBuffer();
15: 
16:     hasher.update(new Uint8Array(buffer));
17:   }
18: 
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | hasher.update on file chunks; not a DB call | wrong |

### #678 · immich-app/immich@f7b8ae5da3 · `web/src/lib/workers/hash-file.ts:30`

```
28:     const buffer = await slice.arrayBuffer();
29: 
30:     hasher.update(new Uint8Array(buffer));
31:   }
32: 
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | hasher.update on file chunks; not a DB call | wrong |

### #911 · zulip/zulip@36d2312680 · `web/src/drafts.ts:317`

```
315:     new_topic: string | undefined,
316: ): void {
317:     for (const [draft_id, draft] of Object.entries(draft_model.get())) {
318:         if (draft.type !== "stream" || draft.stream_id === undefined) {
319:             continue;
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | iterates in-memory draft_model.get() (local storage); not a DB call | wrong |

### #923 · zulip/zulip@36d2312680 · `web/src/message_fetch.ts:839`

```
837:         // Since we backfill a lot more messages here compared to rendered message list,
838:         // we can try populating them if we can do so locally.
839:         for (const msg_list_data of message_list_data_cache.all()) {
840:             if (
841:                 msg_list_data === recent_view_messages_data ||
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | iterates in-memory message_list_data_cache.all(); not a DB call | wrong |

### #929 · zulip/zulip@36d2312680 · `web/src/pm_conversations.ts:191`

```
189:     initialize(params: StateData["pm_conversations"]): void {
190:         for (const conversation of params.recent_private_conversations) {
191:             this.insert(conversation.user_ids, conversation.max_message_id);
192:         }
193:     }
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | in-memory insert into recent DM map during client init; not a DB call | wrong |

### #1378 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/core/api/entity-data-subscription.ts:1150`

```
1148:             let value = EntityDataSubscription.convertValue(series[1]);
1149:             if (dataKey.postFunc) {
1150:               value = dataKey.postFunc.execute(time, value, prevSeries[1], prevOrigSeries[0], prevOrigSeries[1]);
1151:             }
1152:             series = [time, value, series[2]];
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | postFunc.execute is a user JS function on widget data; not a DB call | wrong |

### #1379 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/core/api/entity-data-subscription.ts:1235`

```
1233:     }
1234:     for (let time = startTime; time <= endTime && (this.timeseriesTimer || this.history); time += targetFrequency) {
1235:       const value = dataKey.func.execute(time, prevSeries[1]);
1236:       const series: [number, any] = [time, value];
1237:       data.push(series);
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | func.execute generates simulated data points; not a DB call | wrong |

### #1439 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/cards/aggregated-value-card-widget.component.ts:246`

```
244:           aggValue.value = 'N/A';
245:         }
246:         aggValue.color.update(value);
247:         const numeric = formatNumberValue(value, (aggValue.key.decimals || this.ctx.decimals));
248:         if (aggValue.showArrow && isDefined(numeric)) {
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | color.update on widget value in UI; not a DB call | wrong |

### #1460 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/entity/entities-table-widget.component.ts:1031`

```
1029:               map(compiled => {
1030:                 if (compiled) {
1031:                   return compiled.execute(dataTs, dataValue, 0, 0, 0);
1032:                 } else {
1033:                   return dataValue;
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | compiled post-processing function execute in UI; not a DB call | wrong |

### #1509 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/shared/components/led-light.component.ts:64`

```
62:           this.draw();
63:         } else if (propName === 'size') {
64:           this.update();
65:         }
66:       }
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | component update() on Angular input changes; not a DB call | wrong |

### #1703 · go-gitea/gitea@85211296dd · `web_src/js/webcomponents/relative-time.ts:229`

```
227:     for (const timeEl of this.elements) {
228:       nearestDistance = Math.min(nearestDistance, getUnitFactor(timeEl));
229:       timeEl.update();
230:     }
231:     this.time = Math.min(60 * 60 * 1000, nearestDistance);
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | custom element timeEl.update() re-render; not a DB call | wrong |


## `bpm-perf-orm-call-in-loop-py`

### #682 · saleor/saleor@1771e1cf6c · `saleor/app/tasks.py:98`

```
96:     # on database when removing many deliveries.
97:     for app in apps.iterator(chunk_size=1000):
98:         webhooks = Webhook.objects.filter(app_id=app.id)
99: 
100:         # Saleor uses batch size here to prevent timeouts on database.
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | removes apps one by one deliberately to avoid DB timeouts; filter is lazy; intentional serial batching | wrong |

### #713 · saleor/saleor@1771e1cf6c · `saleor/core/development/random_data.py:731`

```
729:         channel = defaults.pop("channel")
730:         defaults["channel_id"] = channel_USD.pk if channel == 1 else channel_PLN.pk
731:         ProductVariantChannelListing.objects.update_or_create(pk=pk, defaults=defaults)
732: 
733: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | dev sample-data populate, update_or_create per fixture row; fixed bundled fixture, dev-only | small |

### #714 · saleor/saleor@1771e1cf6c · `saleor/core/development/random_data.py:743`

```
741:         defaults["attribute_id"] = defaults.pop("attribute")
742:         defaults["product_type_id"] = defaults.pop("product_type")
743:         association_model.objects.update_or_create(pk=pk, defaults=defaults)
744: 
745: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | dev sample-data populate, update_or_create per fixture attribute assignment; fixed fixture | small |

### #731 · saleor/saleor@1771e1cf6c · `saleor/core/development/random_data.py:2026`

```
2024:         )
2025:         address.save()
2026:         warehouse, _ = Warehouse.objects.update_or_create(
2027:             name=shipping_zone_name,
2028:             slug=slugify(shipping_zone_name),
2029:             defaults={
```

| Proposed | Reason | Brad |
|---|---|---|
| small | dev sample-data: one warehouse update_or_create per shipping zone; a handful | small |

### #742 · saleor/saleor@1771e1cf6c · `saleor/core/development/random_data.py:2223`

```
2221:         defaults = dict(page_data["fields"])
2222:         defaults["page_type_id"] = defaults.pop("page_type")
2223:         page, _ = Page.objects.update_or_create(pk=pk, defaults=defaults)
2224:         yield f"Page {page.slug} created"
2225: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | dev sample-data: update_or_create per fixture page; fixed small fixture | small |

### #743 · saleor/saleor@1771e1cf6c · `saleor/core/development/random_data.py:2237`

```
2235:         defaults = dict(settings_item["fields"])
2236: 
2237:         SiteSettings.objects.update_or_create(pk=pk, defaults=defaults)
2238:         yield "Site settings updated"
2239: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | dev sample-data: site settings fixture (one row); update_or_create per item | small |

### #749 · saleor/saleor@1771e1cf6c · `saleor/core/development/random_data.py:2345`

```
2343:     TaxClassCountryRate.objects.bulk_create(
2344:         [
2345:             TaxClassCountryRate(country=country, rate=rate)
2346:             for country, rate in DEFAULT_COUNTRY_TAX_RATES.items()
2347:         ],
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | model constructor inside list comprehension passed to bulk_create; already batched, no query per item | wrong |

### #754 · saleor/saleor@1771e1cf6c · `saleor/core/schedules.py:227`

```
225:                 filter_kwargs["created_at__gte"] = cut_off_date
226:             if (
227:                 Checkout.objects.using(settings.DATABASE_CONNECTION_REPLICA_NAME)
228:                 .filter(Q(email__isnull=False) | Q(user__isnull=False))
229:                 .filter(
```

| Proposed | Reason | Brad |
|---|---|---|
| small | per channel with auto-completion enabled, one exists() query; channels are few config rows | small |

### #763 · saleor/saleor@1771e1cf6c · `saleor/graphql/attribute/dataloaders/assigned_attributes.py:610`

```
608:             attribute_ids = [val[1] for val in values]
609: 
610:             assigned_attribute_values = AssignedPageAttributeValue.objects.using(
611:                 self.database_connection_name
612:             ).annotate(attribute_id=F("value__attribute_id"))
613:             if limit is not None:
```

| Proposed | Reason | Brad |
|---|---|---|
| small | one query per distinct limit value inside a dataloader batch; already batched by design | small |

### #768 · saleor/saleor@1771e1cf6c · `saleor/graphql/attribute/mutations/utils.py:19`

```
17:         return []
18:     assigned_variant_values = models.AssignedVariantAttributeValue.objects.filter(
19:         value_id__in=[v.id for v in values]
20:     )
21:     assigned_attributes = models.AssignedVariantAttribute.objects.filter(
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | list comprehension of ids inside a single filter(value_id__in=...); no per-item query | wrong |

### #783 · saleor/saleor@1771e1cf6c · `saleor/graphql/order/bulk_mutations/draft_orders.py:199`

```
197:         """Get the instances channel ids for channel permission accessible check."""
198:         orders = models.Order.objects.filter(
199:             id__in=[line.order_id for line in instances]
200:         )
201:         return channel_models.Channel.objects.filter(
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | list comprehension of order ids inside one filter(id__in=...); no per-item query | wrong |

### #787 · saleor/saleor@1771e1cf6c · `saleor/graphql/order/filters.py:339`

```
337:         if warehouse_value := input_data.get("warehouse"):
338:             if fulfillment_qs is None:
339:                 fulfillment_qs = Fulfillment.objects.using(qs.db)
340:             fulfillment_qs = filter_fulfillments_by_warehouse_details(
341:                 value=warehouse_value, qs=fulfillment_qs
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | builds lazy Fulfillment querysets combined into one Exists lookup; no query per iteration | wrong |

### #795 · saleor/saleor@1771e1cf6c · `saleor/graphql/order/utils.py:320`

```
318:             continue
319:         product_channel_listing = (
320:             ProductChannelListing.objects.using(database_connection_name)
321:             .filter(channel_id=channel.id, product_id=variant.product_id)
322:             .first()
```

| Proposed | Reason | Brad |
|---|---|---|
| true | per order line, ProductChannelListing filter().first() query; N+1, batch by product_id__in | true |

### #813 · saleor/saleor@1771e1cf6c · `saleor/graphql/shipping/mutations/shipping_method_channel_listing_update.py:103`

```
101:             if "price_amount" in add_channel.keys():
102:                 defaults["price_amount"] = add_channel.get("price_amount")
103:             ShippingMethodChannelListing.objects.update_or_create(
104:                 shipping_method=shipping_method,
105:                 channel=add_channel["channel"],
106:                 defaults=defaults,
```

| Proposed | Reason | Brad |
|---|---|---|
| small | update_or_create per channel in mutation input; channels are a few | small |

### #828 · saleor/saleor@1771e1cf6c · `saleor/order/tasks.py:134`

```
132:     OrderEvent.objects.bulk_create(
133:         [
134:             OrderEvent(
135:                 order_id=order_id,
136:                 type=OrderEvents.EXPIRED,
137:             )
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | OrderEvent constructor in list comprehension for bulk_create; no per-item query | wrong |

### #831 · saleor/saleor@1771e1cf6c · `saleor/payment/tasks.py:156`

```
154:                 TransactionEvent.objects.bulk_create(
155:                     [event for _tr, event in transactions_with_cancel_request_events]
156:                     + [event for _tr, event in transactions_with_charge_request_events]
157:                 )
158:                 # Mark transactions as not refundable to avoid multiple automatic
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | list concatenation passed to one bulk_create; no per-item query | wrong |

### #842 · saleor/saleor@1771e1cf6c · `saleor/product/tasks.py:103`

```
101:             for variant in variants_batch
102:         ]
103:         ProductVariant.objects.bulk_update(variants_to_update, ["name", "updated_at"])
104: 
105: 
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | bulk_update per batch of variants; deliberately batched | wrong |

### #987 · zulip/zulip@36d2312680 · `zerver/actions/message_flags.py:62`

```
60:             # UPDATE queries don't support LIMIT, so we have to use a subquery
61:             # to do batching.
62:             updated_count = UserMessage.objects.filter(id__in=query).update(
63:                 flags=F("flags").bitor(UserMessage.flags.read),
64:             )
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | batched UPDATE loop with LIMIT subquery per batch; intentional chunked writes under locks | wrong |

### #996 · zulip/zulip@36d2312680 · `zerver/actions/navigation_views.py:96`

```
94:     now = timezone_now()
95:     for audit_log_extra_data in audit_logs_extra_data:
96:         RealmAuditLog.objects.create(
97:             realm=user.realm,
98:             acting_user=user,
99:             modified_user=user,
```

| Proposed | Reason | Brad |
|---|---|---|
| small | creates one audit log per changed property (at most 2); tiny loop | small |

### #1027 · zulip/zulip@36d2312680 · `zerver/lib/import_realm.py:1917`

```
1915:         bulk_import_model(data, DirectMessageGroup)
1916:         for direct_message_group in DirectMessageGroup.objects.filter(recipient=None):
1917:             recipient = Recipient.objects.get(
1918:                 type=Recipient.DIRECT_MESSAGE_GROUP, type_id=direct_message_group.id
1919:             )
1920:             direct_message_group.recipient = recipient
```

| Proposed | Reason | Brad |
|---|---|---|
| true | realm import: Recipient.get + save per direct message group; grows with imported data, batchable | true |

### #1043 · zulip/zulip@36d2312680 · `zerver/lib/migrate.py:108`

```
106:                             "ALTER TABLE {table_name} DROP CONSTRAINT {old_name}"
107:                         ).format(table_name=Identifier(old_table), old_name=Identifier(old_name))
108:                     cursor.execute(raw_query)
109:                     continue
110: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | migration renaming/dropping indexes of one table; a handful of DDL statements | small |

### #1061 · zulip/zulip@36d2312680 · `zerver/lib/upload/__init__.py:676`

```
674:             emoji_bytes_io, emoji_filename, realm_emoji.author, content_type
675:         )
676:         realm_emoji.save(update_fields=["is_animated"])
677: 
678: 
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | per emoji reupload: HTTP fetch + upload then save; per-item network work dominates, save inherent | wrong |

### #1140 · zulip/zulip@36d2312680 · `zilencer/management/commands/populate_db.py:161`

```
159:         RemoteZulipServer,
160:     ]:
161:         model.objects.all().delete()
162:     Session.objects.all().delete()
163:     post_delete.connect(flush_alert_word, sender=AlertWord)
```

| Proposed | Reason | Brad |
|---|---|---|
| small | delete() over a fixed list of ~12 models in dev populate_db | small |

### #1152 · zulip/zulip@36d2312680 · `zilencer/management/commands/populate_db.py:1209`

```
1207:             # Add a few default streams
1208:             for default_stream_name in ["design", "devel", "social", "support"]:
1209:                 DefaultStream.objects.create(
1210:                     realm=zulip_realm, stream=get_stream(default_stream_name, zulip_realm)
1211:                 )
1212: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | creates 4 fixed DefaultStream rows in dev populate_db | small |

### #1160 · zulip/zulip@36d2312680 · `zilencer/views.py:1418`

```
1416:             if (
1417:                 billing_session.on_paid_plan()
1418:                 and not RemoteRealmAuditLog.objects.filter(
1419:                     server=server,
1420:                     remote_realm=remote_realm,
1421:                     event_type=AuditLogEventType.REMOTE_REALM_LOCALLY_DELETED,
```

| Proposed | Reason | Brad |
|---|---|---|
| small | exists() audit-log check per locally deleted remote realm on paid plan; a few realms per server | small |

### #1197 · paperless-ngx/paperless-ngx@5f17b1a310 · `src/documents/bulk_edit.py:704`

```
702:         # bulk_update and not save() to avoid post_save now
703:         Document.objects.bulk_update(
704:             [documents_by_id[source_id] for source_id in source_ids],
705:             updated_fields,
706:         )
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | list comprehension passed to one bulk_update; already batched | wrong |

### #1218 · paperless-ngx/paperless-ngx@5f17b1a310 · `src/documents/serialisers.py:3567`

```
3565:                     )
3566:                     action_instance.webhook = webhook
3567:                     action_instance.save()
3568: 
3569:                 if assign_tags is not None:
```

| Proposed | Reason | Brad |
|---|---|---|
| small | save per workflow action in serializer update; actions per workflow are a few | small |

### #1224 · paperless-ngx/paperless-ngx@5f17b1a310 · `src/documents/tasks.py:575`

```
573:             trigger: WorkflowTrigger
574:             for trigger in schedule_triggers:
575:                 documents = Document.objects.none()
576:                 offset_td = datetime.timedelta(days=trigger.schedule_offset_days)
577:                 threshold = now - offset_td
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | Document.objects.none() is a lazy empty queryset; no query; loop over few scheduled triggers | wrong |

### #1226 · paperless-ngx/paperless-ngx@5f17b1a310 · `src/documents/tasks.py:590`

```
588: 
589:                     case WorkflowTrigger.ScheduleDateField.CREATED:
590:                         documents = Document.objects.filter(
591:                             root_document__isnull=True,
592:                             created__lte=threshold,
593:                         )
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | lazy Document filter per scheduled trigger; one query per trigger is inherent, triggers are few | wrong |

### #1235 · paperless-ngx/paperless-ngx@5f17b1a310 · `src/documents/workflows/ai.py:103`

```
101: 
102:     for name in extract_unmatched_names(names, matched):
103:         tag, created = Tag.objects.get_or_create(
104:             name=name[:128],
105:             owner=owner,
106:         )
```

| Proposed | Reason | Brad |
|---|---|---|
| small | get_or_create per AI-suggested unmatched tag name; a handful of names per document | small |


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
| small | result.pop(0) on pipeline result of 3 per key; keys are a few buffer names | small |

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
| wrong | row.insert(0, links) once per row on a fresh short row list; no accumulation | wrong |

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
| small | insert(0) only for the single primary email; emails per GitHub account a handful | small |


## `bpm-perf-regex-compile-in-loop`

### #211 · outline/outline@670410b236 · `server/models/helpers/TextHelper.ts:116`

```
114:             if (attachment) {
115:               output = output.replace(
116:                 new RegExp(escapeRegExp(image.src), "g"),
117:                 attachment.redirectUrl
118:               );
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | RegExp built from each image src; pattern depends on loop var so hoisting impossible | wrong |

### #297 · outline/outline@670410b236 · `server/queues/tasks/ExportDocumentTreeTask.ts:186`

```
184: 
185:       text = text.replace(
186:         new RegExp(escapeRegExp(attachment.redirectUrl), "g"),
187:         encodeURI(reference)
188:       );
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | RegExp built from each attachment URL; pattern varies per iteration, not hoistable | wrong |

### #309 · outline/outline@670410b236 · `server/queues/tasks/MarkdownAPIImportTask.ts:82`

```
80: 
81:     const normalizedAttachmentPath = encodedPath
82:       .replace(new RegExp(`(.*)/${Buckets.uploads}/`), `${Buckets.uploads}/`)
83:       .replace(new RegExp(`(.*)/${Buckets.public}/`), `${Buckets.public}/`);
84: 
```

| Proposed | Reason | Brad |
|---|---|---|
| true | RegExp with constant Buckets.uploads pattern rebuilt per attachment; loop-invariant, hoistable, grows with imports | true |

### #310 · outline/outline@670410b236 · `server/queues/tasks/MarkdownAPIImportTask.ts:83`

```
81:     const normalizedAttachmentPath = encodedPath
82:       .replace(new RegExp(`(.*)/${Buckets.uploads}/`), `${Buckets.uploads}/`)
83:       .replace(new RegExp(`(.*)/${Buckets.public}/`), `${Buckets.public}/`);
84: 
85:     const attachmentDir = path.basename(path.dirname(attachment.pathInZip));
```

| Proposed | Reason | Brad |
|---|---|---|
| true | RegExp with constant Buckets.public pattern rebuilt per attachment; loop-invariant, hoistable | true |

### #311 · outline/outline@670410b236 · `server/queues/tasks/MarkdownAPIImportTask.ts:89`

```
87: 
88:     text = text
89:       .replace(new RegExp(escapeRegExp(encodedPath), "g"), reference)
90:       .replace(
91:         new RegExp(`\\.?/?${escapeRegExp(normalizedAttachmentPath)}`, "g"),
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | RegExp from each attachment's encoded path; pattern varies per iteration, not hoistable | wrong |

### #312 · outline/outline@670410b236 · `server/queues/tasks/MarkdownAPIImportTask.ts:91`

```
89:       .replace(new RegExp(escapeRegExp(encodedPath), "g"), reference)
90:       .replace(
91:         new RegExp(`\\.?/?${escapeRegExp(normalizedAttachmentPath)}`, "g"),
92:         reference
93:       );
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | RegExp from each attachment's normalized path; pattern varies per iteration | wrong |

### #313 · outline/outline@670410b236 · `server/queues/tasks/MarkdownAPIImportTask.ts:102`

```
100:       const relFromAttachments = segments.slice(attachmentsIdx).join("/");
101:       text = text.replace(
102:         new RegExp(`\\.?/?${escapeRegExp(encodeURI(relFromAttachments))}`, "g"),
103:         reference
104:       );
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | RegExp from each attachment's relative path; pattern varies per iteration | wrong |

### #314 · outline/outline@670410b236 · `server/queues/tasks/MarkdownAPIImportTask.ts:108`

```
106: 
107:     text = text.replace(
108:       new RegExp(`\\.?/?${escapeRegExp(genericNormalizedPath)}`, "g"),
109:       reference
110:     );
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | RegExp from each attachment's generic path; pattern varies per iteration | wrong |

### #358 · outline/outline@670410b236 · `server/routes/api/documents/documents.ts:1112`

```
1110: 
1111:             content = content.replace(
1112:               new RegExp(escapeRegExp(attachment.redirectUrl), "g"),
1113:               encodeURI(reference)
1114:             );
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | RegExp from each attachment redirectUrl; pattern varies per iteration, not hoistable | wrong |

### #359 · outline/outline@670410b236 · `server/routes/api/documents/documents.ts:1155`

```
1153: 
1154:         content = content.replace(
1155:           new RegExp(escapeRegExp(attachment.redirectUrl), "g"),
1156:           location
1157:         );
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | RegExp from each attachment redirectUrl; pattern varies per iteration, not hoistable | wrong |

### #370 · outline/outline@670410b236 · `server/routes/api/revisions/revisions.ts:223`

```
221: 
222:             content = content.replace(
223:               new RegExp(escapeRegExp(attachment.redirectUrl), "g"),
224:               encodeURI(reference)
225:             );
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | regex built from each attachment's redirectUrl inside loop over doc attachments; pattern varies per iteration, cannot hoist | wrong |

### #372 · outline/outline@670410b236 · `server/routes/api/revisions/revisions.ts:266`

```
264: 
265:         content = content.replace(
266:           new RegExp(escapeRegExp(attachment.redirectUrl), "g"),
267:           location
268:         );
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | regex built from each attachment's redirectUrl in zip export loop; pattern is per-attachment, cannot hoist | wrong |

### #901 · zulip/zulip@36d2312680 · `web/src/alert_words.ts:50`

```
48:         const after_punctuation = "(?=\\s)|$|<|[\\)\\\"\\?!:.,';\\]!]";
49: 
50:         const regex = new RegExp(`(${before_punctuation})(${clean})(${after_punctuation})`, "ig");
51:         updated_content = updated_content.replace(
52:             regex,
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | regex built per alert word from the word itself; pattern differs each iteration, nothing to hoist | wrong |

### #913 · zulip/zulip@36d2312680 · `web/src/emoji.ts:122`

```
120:     const translations: EmoticonTranslation[] = [];
121:     for (const [emoticon, replacement_text] of Object.entries(emoticon_conversions)) {
122:         const regex = new RegExp("(" + _.escapeRegExp(emoticon) + ")", "g");
123: 
124:         translations.push({
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | emoticon regexes built once at init and cached in translations list; this is the precompile, not per-message | wrong |

### #947 · zulip/zulip@36d2312680 · `web/third/marked/lib/marked.cjs:321`

```
319:           space -= item.length;
320:           item = !this.options.pedantic
321:             ? item.replace(new RegExp('^ {1,' + space + '}', 'gm'), '')
322:             : item.replace(/^ {1,4}/gm, '');
323:         }
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | marked list parsing: regex depends on per-item indent width `space`; cannot be hoisted as-is | wrong |

### #1468 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/scada/scada-symbol.models.ts:588`

```
586:     for (const id of ids) {
587:       const newId = id + unique_id_suffix;
588:       svgContent = svgContent.replace(new RegExp('id="'+id+'"', 'g'), 'id="'+newId+'"');
589:       svgContent = svgContent.replace(new RegExp('#'+id, 'g'), '#'+newId);
590:     }
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | regex built from each SVG element id to rename it; pattern is per-id, cannot hoist | wrong |

### #1469 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/lib/scada/scada-symbol.models.ts:589`

```
587:       const newId = id + unique_id_suffix;
588:       svgContent = svgContent.replace(new RegExp('id="'+id+'"', 'g'), 'id="'+newId+'"');
589:       svgContent = svgContent.replace(new RegExp('#'+id, 'g'), '#'+newId);
590:     }
591: 
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | regex '#'+id built per SVG id for renaming refs; pattern varies per iteration, cannot hoist | wrong |

### #1544 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/shared/models/widget/maps/marker-shape.models.ts:215`

```
213:   for (const id of ids) {
214:     const newId = id + unique_id_suffix;
215:     svgContent = svgContent.replace(new RegExp('id="'+id+'"', 'g'), 'id="'+newId+'"');
216:     svgContent = svgContent.replace(new RegExp('url\\(#'+id+'\\)', 'g'), 'url(#'+newId+')');
217:   }
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | marker SVG id rename: regex built from each id; per-iteration pattern, cannot hoist | wrong |

### #1545 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/shared/models/widget/maps/marker-shape.models.ts:216`

```
214:     const newId = id + unique_id_suffix;
215:     svgContent = svgContent.replace(new RegExp('id="'+id+'"', 'g'), 'id="'+newId+'"');
216:     svgContent = svgContent.replace(new RegExp('url\\(#'+id+'\\)', 'g'), 'url(#'+newId+')');
217:   }
218:   return SVG(svgContent).node;
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | marker SVG url(#id) regex built from each id; per-iteration pattern, cannot hoist | wrong |


## `bpm-perf-string-concat-in-loop`

### #16 · excalidraw/excalidraw@b7de45e881 · `packages/excalidraw/actions/actionProperties.tsx:1237`

```
1235:         ) {
1236:           const textElement = selectedTextElements[i] as ExcalidrawTextElement;
1237:           textLengthAccumulator += textElement?.originalText.length || 0;
1238:           i++;
1239:         }
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | numeric += (textLengthAccumulator counts text lengths), not string concatenation | wrong |

### #41 · excalidraw/excalidraw@b7de45e881 · `packages/excalidraw/subset/woff2/woff2-bindings.ts:461`

```
459:         let u0 = u8Array[idx++];
460:         if (!(u0 & 128)) {
461:           str += String.fromCharCode(u0);
462:           continue;
463:         }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | emscripten UTF8ArrayToString char loop only for strings <=16 bytes (longer use TextDecoder) | small |

### #42 · excalidraw/excalidraw@b7de45e881 · `packages/excalidraw/subset/woff2/woff2-bindings.ts:466`

```
464:         const u1 = u8Array[idx++] & 63;
465:         if ((u0 & 224) == 192) {
466:           str += String.fromCharCode(((u0 & 31) << 6) | u1);
467:           continue;
468:         }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | same UTF8 decode fallback, only taken for <=16-byte strings; TextDecoder handles longer | small |

### #49 · excalidraw/excalidraw@b7de45e881 · `packages/excalidraw/subset/woff2/woff2-bindings.ts:2766`

```
2764:                 } else {
2765:                   str += String.fromCharCode(0);
2766:                   str += stringSegment;
2767:                 }
2768:                 decodeStartPtr = currentBytePtr + 1;
```

| Proposed | Reason | Brad |
|---|---|---|
| small | embind std::string decode joins a few NUL-separated segments of one string | small |

### #55 · outline/outline@670410b236 · `app/actions/definitions/developer.tsx:104`

```
102:   let text = "";
103:   for (let i = 0; i < Math.floor(Math.random() * 10) + 1; i++) {
104:     text += characters.charAt(Math.floor(Math.random() * characters.length));
105:   }
106:   return text;
```

| Proposed | Reason | Brad |
|---|---|---|
| small | dev action builds random text of 1-10 chars | small |

### #60 · outline/outline@670410b236 · `app/components/CommandBar/SearchIndex.ts:159`

```
157:       out += trimmedText.slice(cursor, from);
158:     }
159:     out += `<b>${trimmedText.slice(from, to)}</b>`;
160:     cursor = to;
161:   }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | search snippet highlighting over match ranges within a bounded text window | small |

### #402 · outline/outline@670410b236 · `shared/editor/marks/Code.ts:200`

```
198:       let result = len > 0 && side > 0 ? " `" : "`";
199:       for (let i = 0; i < len; i++) {
200:         result += "`";
201:       }
202:       if (len > 0 && side < 0) {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | appends backticks equal to longest backtick run in one code mark; a few chars | small |

### #921 · zulip/zulip@36d2312680 · `web/src/list_widget.ts:503`

```
501:                 // append the HTML or nothing if corrupt (null, undef, etc.).
502:                 if (item_html) {
503:                     html += item_html;
504:                 }
505:             }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | list_widget renders a slice of LOAD_COUNT items per batch into html string | small |

### #931 · zulip/zulip@36d2312680 · `web/src/popover_menus_data.ts:626`

```
624:             groups.push(current_group);
625:         }
626:         current_group.message_count += 1;
627:     }
628: 
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | numeric += (message_count increment), not string concatenation | wrong |

### #943 · zulip/zulip@36d2312680 · `web/src/unread.ts:368`

```
366:             );
367:             stream_counts_by_id.set(stream_id, stream_count_info);
368:             stream_unread_messages += stream_count_info.unmuted_count;
369:             followed_topic_unread_messages += stream_count_info.followed_count;
370:         }
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | numeric += summing unread counts per stream, not string concatenation | wrong |

### #964 · zulip/zulip@36d2312680 · `web/third/marked/lib/marked.cjs:801`

```
799:     if (cap = this.rules.code.exec(src)) {
800:       src = src.substring(cap[0].length);
801:       out += this.renderer.codespan(escape(cap[2], true));
802:       continue;
803:     }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | marked inline lexer output for one message; message size capped, JS ropes make += cheap | small |

### #968 · zulip/zulip@36d2312680 · `web/third/marked/lib/marked.cjs:829`

```
827:     if (cap = this.rules.unicodeemoji.exec(src)) {
828:       src = src.substring(cap[0].length);
829:       out += this.unicodeEmoji(cap[1]);
830:       continue;
831:     }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | marked inline lexer output for one message's tokens; bounded message size | small |

### #971 · zulip/zulip@36d2312680 · `web/third/marked/lib/marked.cjs:854`

```
852:     if (cap = this.rules.text.exec(src)) {
853:       src = src.substring(cap[0].length);
854:       out += this.renderer.text(escape(this.smartypants(cap[0])));
855:       continue;
856:     }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | marked inline text output for one message; bounded message size | small |

### #973 · zulip/zulip@36d2312680 · `web/third/marked/lib/marked.cjs:1260`

```
1258:   var out = '';
1259:   while (this.next()) {
1260:     out += this.tok();
1261:   }
1262: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | marked Parser.parse joins tokens of one message; bounded message size | small |

### #974 · zulip/zulip@36d2312680 · `web/third/marked/lib/marked.cjs:1307`

```
1305: 
1306:   while (this.peek().type === 'text') {
1307:     body += '\n' + this.next().text;
1308:   }
1309: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | marked parseText joins consecutive text tokens of one message | small |

### #1248 · thingsboard/thingsboard@7a53801216 · `application/src/main/data/resources/js_modules/ai-summary-module.js:270`

```
268:             } else if (line.trim() === '') {
269:                 if (currentParagraph.length > 0) {
270:                     result += `<p>${currentParagraph.join('<br>')}</p>`;
271:                     currentParagraph = [];
272:                 }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | markdown-to-html of one AI summary's lines; small bounded text | small |

### #1296 · thingsboard/thingsboard@7a53801216 · `common/script/script-api/src/main/resources/js/converter-helpers.js:22`

```
20:         str.charAt(idx | 0) || (map = '=', idx % 1);
21:         // "8 - idx % 1 * 8" generates the sequence 2, 4, 6, 8
22:         output += map.charAt(63 & block >> 8 - idx % 1 * 8)
23:     ) {
24:         charCode = str.charCodeAt(idx += 3/4);
```

| Proposed | Reason | Brad |
|---|---|---|
| true | btoa polyfill appends one char per output char over whole converter payload; join/array would avoid it | true |

### #1297 · thingsboard/thingsboard@7a53801216 · `common/script/script-api/src/main/resources/js/converter-helpers.js:48`

```
46:             // and if not first of each 4 characters,
47:             // convert the first 8 bits to one ascii character
48:         bc++ % 4) ? output += String.fromCharCode(255 & bs >> (-2 * bc & 6)) : 0
49:     ) {
50:         // try to find character in table (0-63, not found => -1)
```

| Proposed | Reason | Brad |
|---|---|---|
| true | atob polyfill appends one char per decoded byte over whole payload string | true |

### #1382 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/core/css/css.ts:55`

```
53:       } else if (ch === '/' && cssString[i + 1] === '*') {
54:         const end = cssString.indexOf('*/', i + 2);
55:         result += cssString.slice(start, i);
56:         i = start = end === -1 ? cssString.length : end + 2;
57:       } else {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | strip CSS comments: appends segments between comments of one widget CSS string | small |

### #1383 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/core/css/css.ts:192`

```
190:     for (const block of this.splitBlocks(body)) {
191:       if ('text' in block) {
192:         text += block.text;
193:       } else {
194:         rules.push(...this.parseRules(text));
```

| Proposed | Reason | Brad |
|---|---|---|
| small | accumulates text blocks of one CSS rule body before parsing | small |

### #1384 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/core/css/css.ts:282`

```
280:       } else if (trimmedLine.startsWith('base64,')) {
281:         if (result.length > 0) {
282:           result[result.length - 1].value += trimmedLine;
283:         }
284:       } else if (trimmedLine) {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | appends base64 continuation lines to a single CSS declaration value | small |

### #1388 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/core/css/css.ts:497`

```
495:         result += `${spaces}${obj.styles}\n\n`;
496:       } else if (obj.type !== 'keyframes' && obj.type !== 'imports') {
497:         result += `${spaces}${obj.selector} {\n${this.getCSSOfRules(obj.rules ?? [], depth + 1)}${spaces}}\n\n`;
498:       }
499:     }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | generates editor CSS text over parsed rules of one widget stylesheet | small |

### #1399 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/core/utils.ts:998`

```
996:   let result = '';
997:   for ( let i = 0; i < length; i++ ) {
998:     result += alphanumericCharacters.charAt(Math.floor(Math.random() * alphanumericCharactersLength));
999:   }
1000:   return result;
```

| Proposed | Reason | Brad |
|---|---|---|
| small | randomAlphanumeric(length) for short ids; length is small by design | small |

### #1401 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/alarm-rules/cf-alarm-rule-condition.component.ts:275`

```
273:                 this.scheduleText += ', ';
274:               }
275:               this.scheduleText += this.translate.instant(dayOfWeekTranslations[day - 1]);
276:             }
277:             this.scheduleText += ' <b>' + getAlarmScheduleRangeText(utcTimestampToTimeOfDay(schedule.staticValue.startsOn),
```

| Proposed | Reason | Brad |
|---|---|---|
| small | joins day-of-week names (max 7) for schedule text | small |

### #1420 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/profile/alarm/alarm-schedule-info.component.ts:94`

```
92:             }
93:             this.scheduleText += this.translate.instant(dayOfWeekTranslations[item.dayOfWeek  - 1]);
94:             this.scheduleText += ' <b>' + getAlarmScheduleRangeText(utcTimestampToTimeOfDay(item.startsOn),
95:               utcTimestampToTimeOfDay(item.endsOn)) + '</b>';
96:           }
97:         }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | joins enabled schedule items, at most 7 weekdays | small |

### #1433 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/modules/home/components/widget/action/manage-widget-actions.component.models.ts:70`

```
68:     const importedActions = importedMap[actionSourceId];
69:     if (!actionSource) {
70:       result.skipped += importedActions.length;
71:       continue;
72:     }
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | numeric += (skipped count), not string concatenation | wrong |

### #1521 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/shared/models/ace/completion.models.ts:174`

```
172:           let strArg = `<tr><td class="arg-name"><code>${arg.name}`;
173:           if (arg.optional) {
174:             strArg += ' (optional)';
175:           }
176:           strArg += '</code></td><td>';
```

| Proposed | Reason | Brad |
|---|---|---|
| small | builds one HTML row per completion arg; few appends to a short per-arg string | small |

### #1525 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/shared/models/ace/completion.models.ts:182`

```
180:           strArg += '</td><td class="arg-description">';
181:           if (arg.description) {
182:             strArg += `${arg.description}`;
183:           }
184:           strArg += '</td></tr>';
```

| Proposed | Reason | Brad |
|---|---|---|
| small | builds one HTML row per completion arg; few appends to a short per-arg string | small |

### #1528 · thingsboard/thingsboard@7a53801216 · `ui-ngx/src/app/shared/models/ace/tbel/worker-tbel.js:1193`

```
1191: 
1192:         if (count >>= 1)
1193:             string += string;
1194:     }
1195:     return result;
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | stringRepeat uses doubling (O(log n) concats); already the efficient algorithm | wrong |

### #1688 · go-gitea/gitea@85211296dd · `web_src/js/modules/shortcut.ts:110`

```
108:     let keysHtml = '';
109:     for (const keys of shortcutKeys.split(' ')) {
110:       keysHtml += html`<kbd>${keys}</kbd> `;
111:     }
112:     list.append(createElementFromHTML(html`<tr><td>${htmlRaw(keysHtml)}</td><td>${label}</td></tr>`));
```

| Proposed | Reason | Brad |
|---|---|---|
| small | joins kbd tags for the few keys of one shortcut | small |


## `bpm-perf-string-concat-in-loop-py`

### #687 · saleor/saleor@1771e1cf6c · `saleor/asgi/gzip_compression.py:111`

```
109:                                 if key.lower() == b"vary":
110:                                     if b"Accept-Encoding" not in value:
111:                                         value += b", Accept-Encoding"
112:                                         break
113:                             start_message["headers"] = headers
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | single bytes append to Vary header value then break; not accumulating in a loop | wrong |

### #858 · zulip/zulip@36d2312680 · `corporate/views/audit_logs.py:32`

```
30:     for role, count in human_count_raw.items():
31:         if int(count) > 0:
32:             human_count_string += f"{(role)}: {count}, "
33:     return human_count_string.strip(", ")
34: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | joins human role counts from a dict of a handful of roles | small |

### #859 · zulip/zulip@36d2312680 · `corporate/views/installation_activity.py:322`

```
320:             RealmAuditLog.HOW_REALM_CREATOR_FOUND_ZULIP_OPTIONS["ai_chatbot"],
321:         ):
322:             row["how_realm_creator_found_zulip"] += f": {extra_context}"
323:         elif how_found == RealmAuditLog.HOW_REALM_CREATOR_FOUND_ZULIP_OPTIONS["existing_user"]:
324:             row["how_realm_creator_found_zulip"] = f"Organization: {extra_context}"
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | one append to a per-row field per realm; no string accumulated across iterations | wrong |

### #861 · zulip/zulip@36d2312680 · `corporate/views/realm_activity.py:155`

```
153:             row_class += " recently_active"
154:         if email in admin_emails:
155:             row_class += " admin"
156: 
157:         row = dict(cells=cells, row_class=row_class)
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | fresh per-row row_class with at most 2 appends; nothing accumulated across loop | wrong |

### #867 · zulip/zulip@36d2312680 · `tools/lib/html_branches.py:69`

```
67:             s = ""
68:         else:
69:             s += ch
70:     if s != "":
71:         lst.append(s)
```

| Proposed | Reason | Brad |
|---|---|---|
| small | char loop over a single template tag attribute string | small |

### #883 · zulip/zulip@36d2312680 · `tools/upload-release:112`

```
110:     # natsorted type annotation is insufficiently generic
111:     assert isinstance(ordered_filename, str)
112:     contents += f"{file_hashes[ordered_filename]}  {ordered_filename}\n"
113: bucket.put_object(
114:     ACL="public-read",
```

| Proposed | Reason | Brad |
|---|---|---|
| small | one-off release script writing SHA256SUMS over release file list | small |

### #1007 · zulip/zulip@36d2312680 · `zerver/data_import/mattermost.py:601`

```
599:                 has_link = True
600:                 if content:
601:                     content += "\n\n"
602:                 content += attachment_markdown
603: 
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | per-message content gets at most 2 appends; string not accumulated across messages | wrong |

### #1032 · zulip/zulip@36d2312680 · `zerver/lib/markdown/api_arguments_table_generator.py:135`

```
133:                 )
134:             elif "description" in element:
135:                 content += ONEOF_LIST_ITEM_TEMPLATE.format(
136:                     item=md_engine.convert(element["description"])
137:                 )
138:         return ONEOF_DETAILS_TEMPLATE.format(values=content)
```

| Proposed | Reason | Brad |
|---|---|---|
| small | concatenates rendered oneOf variants of one schema; a few elements | small |

### #1036 · zulip/zulip@36d2312680 · `zerver/lib/markdown/api_arguments_table_generator.py:246`

```
244:                     OBJECT_CODE_TEMPLATE.format(value=json.dumps(enum)) for enum in enums
245:                 ]
246:                 additions += "Must be one of: {}. ".format(", ".join(formatted_enums))
247: 
248:             if "example" in object_values[value]:
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | additions is list[str]; += extends list (not string concat), at most once per field | wrong |

### #1083 · zulip/zulip@36d2312680 · `zerver/openapi/merge_api_changelogs.py:28`

```
26:         file_path = Path(f"{dir_path}/{file_name}")
27:         with open(file_path) as f:
28:             changelogs += f.read().strip("\n") + "\n"
29: 
30:     return changelogs
```

| Proposed | Reason | Brad |
|---|---|---|
| small | concatenates a few unmerged changelog fragment files in a dev tool | small |

### #1084 · zulip/zulip@36d2312680 · `zerver/openapi/merge_api_changelogs.py:84`

```
82:         for line in lines:
83:             file.write(line)
84:             changelog_markdown_string += line
85:             if changelogs_merged:
86:                 continue
```

| Proposed | Reason | Brad |
|---|---|---|
| true | accumulates every line of api_docs/changelog.md (grows each release) via +=; use join/list | true |

### #1087 · zulip/zulip@36d2312680 · `zerver/views/message_fetch.py:62`

```
60:                 in_tag = False
61:         if in_tag:
62:             result += prefix
63:             result += match
64:         else:
```

| Proposed | Reason | Brad |
|---|---|---|
| small | highlight_string over search match locations within one message | small |

### #1088 · zulip/zulip@36d2312680 · `zerver/views/message_fetch.py:63`

```
61:         if in_tag:
62:             result += prefix
63:             result += match
64:         else:
65:             result += prefix
```

| Proposed | Reason | Brad |
|---|---|---|
| small | highlight_string over search match locations within one message | small |

### #1090 · zulip/zulip@36d2312680 · `zerver/views/message_fetch.py:66`

```
64:         else:
65:             result += prefix
66:             result += highlight_start
67:             result += match
68:             result += highlight_stop
```

| Proposed | Reason | Brad |
|---|---|---|
| small | highlight_string over search match locations within one message | small |

### #1093 · zulip/zulip@36d2312680 · `zerver/views/streams.py:633`

```
631:     message += "\n\n"
632:     for channel_name in subscriptions:
633:         message += f"* #**{channel_name}**\n"
634:     return message
635: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | lists channels a user was subscribed to in one notification message | small |

### #1095 · zulip/zulip@36d2312680 · `zerver/webhooks/ansibletower/view.py:100`

```
98:     hosts_content = ""
99:     for host in hosts_data:
100:         hosts_content += ANSIBLETOWER_JOB_HOST_ROW_TEMPLATE.format(
101:             hostname=host["hostname"],
102:             status=host["status"],
103:         )
```

| Proposed | Reason | Brad |
|---|---|---|
| small | webhook message rows for hosts of one Ansible job | small |

### #1096 · zulip/zulip@36d2312680 · `zerver/webhooks/bitbucket/view.py:477`

```
475:             )
476:             message = append_punctuation(str(new.value), message) + "\n"
477:             body += message
478:         elif new and not old:
479:             message = BITBUCKET_REPO_UPDATED_ADDED.format(
```

| Proposed | Reason | Brad |
|---|---|---|
| small | loop over fixed list of 6 repo change fields | small |

### #1099 · zulip/zulip@36d2312680 · `zerver/webhooks/freshstatus/view.py:119`

```
117:     services_content = ""
118:     for service in services_data[:FRESHSTATUS_SERVICES_LIMIT]:
119:         services_content += FRESHSTATUS_SERVICES_ROW_TEMPLATE.format(
120:             service_name=service.get("service_name")
121:         )
122: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | services rows capped at FRESHSTATUS_SERVICES_LIMIT | small |

### #1110 · zulip/zulip@36d2312680 · `zerver/webhooks/grafana/view.py:138`

```
136:                 for key, value in alert["values"].items():
137:                     value_information += "- " + key + ": " + str(value.tame(check_anything)) + "\n"
138:                 body += MESSAGE_VALUES_TEMPLATE.format(value_information=value_information)
139:             elif alert.get("valueString"):
140:                 body += (
```

| Proposed | Reason | Brad |
|---|---|---|
| small | per-alert body built from a fixed handful of template fields; reset per alert | small |

### #1116 · zulip/zulip@36d2312680 · `zerver/webhooks/grafana/view.py:166`

```
164: 
165:             if alert.get("imageURL"):
166:                 body += MESSAGE_IMAGE_TEMPLATE.format(
167:                     image_url=alert["imageURL"].tame(check_string)
168:                 )
169: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | per-alert body built from a fixed handful of template fields; reset per alert | small |

### #1117 · zulip/zulip@36d2312680 · `zerver/webhooks/grafana/view.py:170`

```
168:                 )
169: 
170:             body += "\n"
171: 
172:             check_send_webhook_message(request, user_profile, topic_name, body, status)
```

| Proposed | Reason | Brad |
|---|---|---|
| small | per-alert body newline append; body reset each alert | small |

### #1118 · zulip/zulip@36d2312680 · `zerver/webhooks/grafana/view.py:190`

```
188:     if "evalMatches" in payload:
189:         for match in payload["evalMatches"]:
190:             eval_matches_text += "**{}:** {}\n".format(
191:                 match["metric"].tame(check_string),
192:                 match["value"].tame(check_none_or(check_union([check_int, check_float]))),
193:             )
```

| Proposed | Reason | Brad |
|---|---|---|
| small | evalMatches rows in one Grafana legacy alert payload | small |

### #1122 · zulip/zulip@36d2312680 · `zerver/webhooks/librato/view.py:109`

```
107:         content = ""
108:         for attachment in self.attachments:
109:             content += self.handle_snapshot(attachment)
110:         return content
111: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | snapshot lines for attachments of one Librato webhook | small |

### #1124 · zulip/zulip@36d2312680 · `zerver/webhooks/lidarr/view.py:44`

```
42:     tracks_content = ""
43:     for track in tracks_data[:LIDARR_TRACKS_LIMIT]:
44:         tracks_content += LIDARR_TRACKS_ROW_TEMPLATE.format(track_title=track.get("title"))
45: 
46:     if len(tracks_data) > LIDARR_TRACKS_LIMIT:
```

| Proposed | Reason | Brad |
|---|---|---|
| small | track rows capped at LIDARR_TRACKS_LIMIT=20 | small |

### #1126 · zulip/zulip@36d2312680 · `zerver/webhooks/newrelic/view.py:147`

```
145:                 f"- **{custom_field_name}**: *Value is not a supported data type*\n"
146:             )
147:             body_custom_field_detail += invalid_field_message
148:     return body_custom_field_detail
149: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | custom field lines of one New Relic webhook payload | small |

### #1128 · zulip/zulip@36d2312680 · `zerver/webhooks/reviewboard/view.py:65`

```
63:         output = ""
64:         for elem in list(targets)[:-1]:
65:             output += "**{title}**, ".format(title=elem["title"].tame(check_string))
66:         output += "and **{title}**".format(title=targets[-1]["title"].tame(check_string))
67:         return output
```

| Proposed | Reason | Brad |
|---|---|---|
| small | joins review target titles in one ReviewBoard payload | small |

### #1130 · zulip/zulip@36d2312680 · `zerver/webhooks/sentry/view.py:107`

```
105:                 traceback += "\n"
106:             else:
107:                 traceback += f"     {line}\n"
108:     return traceback
109: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | traceback lines of one Sentry event | small |

### #1144 · zulip/zulip@36d2312680 · `zilencer/management/commands/populate_db.py:570`

```
568:                         full_name += " " + random.choice(non_ascii_names)
569:                     else:
570:                         full_name += " " + random.choice(mnames)
571:                     if random.random() < 0.1:
572:                         full_name += f" {random.choice(raw_emojis)} "
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | fresh full_name per user with <=3 appends; nothing accumulated across loop | wrong |

### #1146 · zulip/zulip@36d2312680 · `zilencer/management/commands/populate_db.py:574`

```
572:                         full_name += f" {random.choice(raw_emojis)} "
573:                     else:
574:                         full_name += " " + random.choice(lnames)
575:                 email = fname.lower().encode("ascii", "ignore").decode("ascii") + "@zulip.com"
576:                 validate_email(email)
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | fresh full_name per user with <=3 appends; nothing accumulated across loop | wrong |

### #1155 · zulip/zulip@36d2312680 · `zilencer/management/commands/populate_db.py:1411`

```
1409:         if has_attachment:
1410:             locator, filename = create_attachment(message.sender)
1411:             message.content += f"\n[{filename}]({locator})"
1412: 
1413:         message.is_channel_message = msg_type == MSG_TYPE_STREAM
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | single attachment link appended to each message's content; not accumulating | wrong |


## `bpm-perf-sync-io-in-async`

### #104 · outline/outline@670410b236 · `build.js:252`

```
250:       // The path of a removed directory maps directly to its output.
251:       const dest = getDest(file) ?? path.join("build", file);
252:       if (existsSync(dest)) {
253:         rmSync(dest, { recursive: true, force: true });
254:         isChanged = true;
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | existsSync in dev build watcher change handler; tooling, not request path | wrong |

### #105 · outline/outline@670410b236 · `build.js:258`

```
256:     } else if (stats.isDirectory()) {
257:       // A directory that was moved in does not emit events for its files.
258:       for (const entry of readdirSync(file, { recursive: true })) {
259:         isChanged = (await updateFile(path.join(file, entry))) || isChanged;
260:       }
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | readdirSync in dev build watcher for moved dir; tooling, not request path | wrong |

### #201 · outline/outline@670410b236 · `server/models/helpers/HTMLHelper.ts:82`

```
80:     if (!initialized) {
81:       const path = require.resolve("@css-inline/css-inline-wasm/index_bg.wasm");
82:       await initWasm(fs.readFileSync(path));
83:       initialized = true;
84:     }
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | readFileSync of wasm once behind initialized flag; one-time init | wrong |

### #422 · immich-app/immich@f7b8ae5da3 · `server/src/app.common.ts:70`

```
68:   useSwagger(app, { write: configRepository.isDev() && permitSwaggerWrite });
69: 
70:   if (existsSync(resourcePaths.web.root)) {
71:     // copied from https://github.com/sveltejs/kit/blob/679b5989fe62e3964b9a73b712d7b41831aa1f07/packages/adapter-node/src/handler.js#L46
72:     // provides serving of precompressed assets and caching of immutable assets
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | existsSync at app bootstrap configuring static serving; one-time startup | wrong |

### #446 · immich-app/immich@f7b8ae5da3 · `server/src/repositories/map.repository.ts:229`

```
227:     const { resourcePaths } = this.configRepository.getEnv();
228:     const filePath = resourcePaths.geodata.countryInfo;
229:     if (!existsSync(filePath)) {
230:       throw new Error(`Geodata file ${filePath} not found`);
231:     }
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | one existsSync before streaming country file, result cached; negligible one-time check | wrong |

### #447 · immich-app/immich@f7b8ae5da3 · `server/src/repositories/map.repository.ts:325`

```
323:     const { resourcePaths } = this.configRepository.getEnv();
324:     const cities500 = resourcePaths.geodata.cities500;
325:     if (!existsSync(cities500)) {
326:       throw new Error(`Geodata file ${cities500} not found`);
327:     }
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | one existsSync before streaming cities500 in geodata import job; negligible | wrong |

### #449 · immich-app/immich@f7b8ae5da3 · `server/src/repositories/map.repository.ts:400`

```
398: 
399:   private async loadAdmin(filePath: string) {
400:     if (!existsSync(filePath)) {
401:       this.logger.error(`Geodata file ${filePath} not found`);
402:       throw new Error(`Geodata file ${filePath} not found`);
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | one existsSync before streaming admin file in geodata import; negligible | wrong |

### #1359 · thingsboard/thingsboard@7a53801216 · `msa/js-executor/queue/kafkaTemplate.ts:147`

```
145: 
146:             if (isNotEmptyStr(certFilePath)) {
147:                 kafkaConfig.ssl.cert = fs.readFileSync(certFilePath, 'utf-8');
148:             }
149: 
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | readFileSync of Kafka SSL cert during one-time client init | wrong |

### #1360 · thingsboard/thingsboard@7a53801216 · `msa/js-executor/queue/kafkaTemplate.ts:151`

```
149: 
150:             if (isNotEmptyStr(keyFilePath)) {
151:                 const keyConfig: KeyObject = {pem: fs.readFileSync(keyFilePath, 'utf-8')};
152:                 if (isNotEmptyStr(keyPassword)) {
153:                     keyConfig.passphrase = keyPassword;
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | readFileSync of Kafka SSL key during one-time client init | wrong |

### #1361 · thingsboard/thingsboard@7a53801216 · `msa/js-executor/queue/kafkaTemplate.ts:159`

```
157: 
158:             if (isNotEmptyStr(caFilePath)) {
159:                 kafkaConfig.ssl.ca = fs.readFileSync(caFilePath, 'utf-8');
160:             }
161:         }
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | readFileSync of Kafka CA during one-time client init | wrong |

### #1666 · go-gitea/gitea@85211296dd · `tools/generate-svg.ts:71`

```
69:     svgSymbols[svgName] = data.replace(/"/g, `'`);
70:   }
71:   writeFileSync(fileURLToPath(new URL(`../options/fileicon/material-icon-svgs.json`, import.meta.url)), JSON.stringify(svgSymbols, null, 2));
72: 
73:   const vscodeExtensionsJson = await readFile(fileURLToPath(new URL(`generate-svg-vscode-extensions.json`, import.meta.url)), 'utf8');
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | writeFileSync in offline SVG generation build script | wrong |

### #1667 · go-gitea/gitea@85211296dd · `tools/generate-svg.ts:112`

```
110:   }
111:   const iconRulesPretty = JSON.stringify(iconRules, null, 2);
112:   writeFileSync(fileURLToPath(new URL(`../options/fileicon/material-icon-rules.json`, import.meta.url)), iconRulesPretty);
113: }
114: 
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | writeFileSync in offline SVG generation build script | wrong |


## `bpm-perf-unbounded-gather-py`

### #1137 · zulip/zulip@36d2312680 · `zilencer/lib/push_notifications.py:57`

```
55:         tuple[RemotePushDevice, aioapns.common.NotificationResult | BaseException]
56:     ]:
57:         results = await asyncio.gather(
58:             *(apns_context.send_notification(request) for request in apns_requests),
59:             return_exceptions=True,
60:         )
```

| Proposed | Reason | Brad |
|---|---|---|
| small | gather over APNs requests for one bounce request's devices; aioapns pools connections | small |


## `bpm-perf-unbounded-promise-all`

### #19 · excalidraw/excalidraw@b7de45e881 · `packages/excalidraw/clipboard.ts:478`

```
476:   }
477: 
478:   const dataItems = (
479:     await Promise.all(
480:       Array.from(items || []).map(
481:         async (item): Promise<ParsedDataTransferItem | null> => {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | Promise.all over items of one clipboard/drag event; a few items | small |

### #36 · excalidraw/excalidraw@b7de45e881 · `packages/excalidraw/components/hyperlink/helpers.ts:124`

```
122:   }
123: 
124:   const statuses = await Promise.all(pending.map((entry) => entry.settled));
125: 
126:   return statuses.includes("decoded");
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | Promise.all over a literal array of at most 2 image decodes | wrong |

### #64 · outline/outline@670410b236 · `app/components/IconPicker/components/EmojiPanel.tsx:122`

```
120:     // Load frequent custom emojis, preserving frequency order and skipping
121:     // any that no longer exist.
122:     void Promise.all(
123:       freqCustomEmojiIds.map((id) => emojis.fetch(id).catch(() => undefined))
124:     ).then((fetched) => {
125:       setFreqCustomEmojis(
```

| Proposed | Reason | Brad |
|---|---|---|
| small | fetches frequent custom emoji ids; frequent-icons list is short | small |

### #70 · outline/outline@670410b236 · `app/components/Sharing/Document/SharePopover.tsx:149`

```
147:         section: UserSection,
148:         perform: async () => {
149:           const invited = await Promise.all(
150:             pendingIds.map(async (idOrEmail) => {
151:               let user, group;
152: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | invites the handful of users/emails the user selected in share popover | small |

### #116 · outline/outline@670410b236 · `plugins/gitlab/server/api/gitlab.ts:363`

```
361:     const teamIds: Array<string | null> = ctx.state.webhookTeamIds ?? [null];
362: 
363:     await Promise.all(
364:       teamIds.map((teamId) =>
365:         new GitLabWebhookTask().schedule({
366:           payload: body,
```

| Proposed | Reason | Brad |
|---|---|---|
| small | schedules one GitLab webhook task per matched team; a few teams | small |

### #128 · outline/outline@670410b236 · `plugins/webhooks/server/processors/WebhookProcessor.ts:51`

```
49:     }
50: 
51:     await Promise.all(
52:       applicableSubscriptions.map((subscription) =>
53:         new DeliverWebhookTask().schedule({
54:           event,
```

| Proposed | Reason | Brad |
|---|---|---|
| small | schedules one delivery task per matching webhook subscription of a team | small |

### #160 · outline/outline@670410b236 · `server/commands/teamPermanentDeleter.ts:85`

```
83:             `Deleting ${attachments.length} attachments…`
84:           );
85:           await Promise.all(
86:             attachments.map((attachment) =>
87:               attachment.destroy({
88:                 transaction,
```

| Proposed | Reason | Brad |
|---|---|---|
| small | destroys attachments within batches of batchLimit 100 | small |

### #176 · outline/outline@670410b236 · `server/mcp/tools/documents.ts:294`

```
292:             ]);
293: 
294:             const presented = await Promise.all(
295:               documents.map(async (document) => {
296:                 const doc = pathToUrl(
297:                   user.team,
```

| Proposed | Reason | Brad |
|---|---|---|
| small | presents search results page; limit max 100 | small |

### #178 · outline/outline@670410b236 · `server/mcp/util.ts:328`

```
326:   );
327:   const byCollection = new Map(
328:     await Promise.all(
329:       readable.map(
330:         async (collection) =>
331:           [
```

| Proposed | Reason | Brad |
|---|---|---|
| small | resolves structure of distinct collections in a result page | small |

### #182 · outline/outline@670410b236 · `server/models/Collection.ts:1056`

```
1054:       id: string
1055:     ) => {
1056:       children = await Promise.all(
1057:         children.map(async (childDocument) => ({
1058:           ...childDocument,
1059:           children: await removeFromChildren(childDocument.children, id),
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | recursive in-memory tree walk; async but no I/O, nothing to bound | wrong |

### #195 · outline/outline@670410b236 · `server/models/UserMembership.ts:231`

```
229:     });
230: 
231:     const rootMemberships = await Promise.all(
232:       memberships.map((membership) =>
233:         membership?.sourceId
234:           ? this.findByPk(membership.sourceId, options)
```

| Proposed | Reason | Brad |
|---|---|---|
| true | findByPk per membership of a document (all users); N lookups unbounded, batch with one findAll | true |

### #209 · outline/outline@670410b236 · `server/models/helpers/TextHelper.ts:86`

```
84: 
85:     for (const chunk of chunks) {
86:       await Promise.all(
87:         chunk.map(async (image) => {
88:           // Skip attempting to fetch images that are not valid urls
89:           try {
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | already chunked into groups of 10 images per Promise.all | wrong |

### #248 · outline/outline@670410b236 · `server/queues/tasks/APIImportTask.ts:180`

```
178: 
179:     const taskOutputWithReplacements = this.shouldUploadAttachmentsPerPage()
180:       ? await Promise.all(
181:           taskOutput.map(async (item) => ({
182:             ...item,
183:             content: await this.uploadAttachments({
```

| Proposed | Reason | Brad |
|---|---|---|
| small | uploads attachments per item of one import page; page size bounded by API | small |

### #252 · outline/outline@670410b236 · `server/queues/tasks/CleanupDemotedUserTask.ts:56`

```
54:           lock: transaction.LOCK.UPDATE,
55:         });
56:         await Promise.all(
57:           apiKeys.map((apiKey) => apiKey.destroy({ transaction }))
58:         );
59:         Logger.info(
```

| Proposed | Reason | Brad |
|---|---|---|
| small | destroys the API keys of one user | small |

### #293 · outline/outline@670410b236 · `server/queues/tasks/ErrorTimedOutFileOperationsTask.ts:29`

```
27:       limit,
28:     });
29:     await Promise.all(
30:       fileOperations.map(async (fileOperation) => {
31:         fileOperation.state = FileOperationState.Error;
32:         fileOperation.error = "Timed out";
```

| Proposed | Reason | Brad |
|---|---|---|
| small | cron limit (default 500) of file ops stuck >12h; realistically very few | small |

### #344 · outline/outline@670410b236 · `server/queues/tasks/ValidateSSOAccessTask.ts:34`

```
32:         let error;
33:         const freshlyValidated: UserAuthentication[] = [];
34:         const validity = await Promise.all(
35:           userAuthentications.map(async (authentication) => {
36:             const previouslyValidatedAt = authentication.lastValidatedAt;
37:             try {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | validates the few SSO authentications of one user | small |

### #346 · outline/outline@670410b236 · `server/routes/api/auth/auth.ts:165`

```
163:       }),
164:       team: presentTeam(team),
165:       groups: await Promise.all(groups.map(presentGroup)),
166:       groupUsers: groups.map((group) => presentGroupUser(group.groupUsers[0])),
167:       // The collaboration token is only for the client and should not be issued
```

| Proposed | Reason | Brad |
|---|---|---|
| small | presents the groups of the signed-in user | small |

### #353 · outline/outline@670410b236 · `server/routes/api/developer/developer.ts:55`

```
53: 
54:     // Convert from invites to active users by marking as active
55:     await Promise.all(
56:       response.users.map((user) => user.updateActiveAt(ctx, true))
57:     );
58: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | dev-only endpoint creating test users | small |

### #356 · outline/outline@670410b236 · `server/routes/api/documents/documents.ts:137`

```
135: 
136:   const expandedIds = new Map<string, string[]>();
137:   await Promise.all(
138:     documentIds.map(async (documentId) => {
139:       if ("user" in context) {
140:         const document = await Document.findByPk(documentId, {
```

| Proposed | Reason | Brad |
|---|---|---|
| small | expands documentId leaves present in one search filter | small |

### #373 · outline/outline@670410b236 · `server/routes/api/revisions/revisions.ts:314`

```
312:     });
313: 
314:     const data = await Promise.all(
315:       revisions.map((revision) =>
316:         presentRevision(revision, { includeContent: false })
317:       )
```

| Proposed | Reason | Brad |
|---|---|---|
| small | presents one paginated page of revisions | small |

### #374 · outline/outline@670410b236 · `server/routes/api/suggestions/suggestions.ts:132`

```
130:           })
131:         ),
132:         groups: await Promise.all(groups.map((group) => presentGroup(group))),
133:         collections,
134:         familiarity,
```

| Proposed | Reason | Brad |
|---|---|---|
| small | presents one paginated page of groups | small |

### #468 · immich-app/immich@f7b8ae5da3 · `server/src/services/database-backup.service.ts:306`

```
304:       .toReversed();
305: 
306:     const backups = await Promise.all(
307:       validFiles.map(async (filename) => {
308:         const stats = await this.storageRepository.stat(path.join(backupsFolder, filename));
309:         return { filename, filesize: stats.size, timezone };
```

| Proposed | Reason | Brad |
|---|---|---|
| small | stats backup files in backups folder; retention keeps a handful | small |

### #476 · immich-app/immich@f7b8ae5da3 · `server/src/services/duplicate.service.ts:195`

```
193: 
194:         if (allowedTagIds.size > 0) {
195:           await Promise.all(
196:             idsToKeep.map((assetId) => this.tagRepository.replaceAssetTags(assetId, [...allowedTagIds])),
197:           );
198: 
```

| Proposed | Reason | Brad |
|---|---|---|
| small | replaces tags for assets in one duplicate group | small |

### #481 · immich-app/immich@f7b8ae5da3 · `server/src/services/integrity.service.ts:325`

```
323:     const trackedPaths = new Set(tracked.map(({ path }) => path));
324: 
325:     const results = await Promise.all(
326:       items.map(async ({ reportId, path }) => {
327:         // The path was untracked when the report was written; an asset may reference it now.
328:         if (trackedPaths.has(path)) {
```

| Proposed | Reason | Brad |
|---|---|---|
| true | stat per path for a job batch of up to 10,000 reports at once; bound concurrency | true |

### #488 · immich-app/immich@f7b8ae5da3 · `server/src/services/integrity.service.ts:609`

```
607:     this.logger.log(`Processing batch of ${paths.length} reports to check if they are out of date.`);
608: 
609:     const results = await Promise.all(
610:       paths.map(async ({ reportId, path, checksum }) => {
611:         if (!checksum) {
612:           return reportId;
```

| Proposed | Reason | Brad |
|---|---|---|
| true | opens and hashes full files for up to 10,000 paths concurrently; fd/IO exhaustion, bound it | true |

### #497 · immich-app/immich@f7b8ae5da3 · `server/src/services/library.service.ts:490`

```
488:     this.logger.debug(`Checking batch of ${assets.length} existing asset(s) in library ${job.libraryId}`);
489: 
490:     const stats = await Promise.all(
491:       assets.map((asset) => this.storageRepository.stat(asset.originalPath).catch(() => null)),
492:     );
493: 
```

| Proposed | Reason | Brad |
|---|---|---|
| true | stat per asset for a library sync batch of up to 10,000 assets at once | true |

### #513 · immich-app/immich@f7b8ae5da3 · `server/src/services/memory.service.ts:46`

```
44:         this.logger.log(`Creating memories for ${target.toISO()}`);
45:         try {
46:           await Promise.all(
47:             users.map((owner) =>
48:               Promise.all([
49:                 this.createOnThisDayMemories(owner.id, target),
```

| Proposed | Reason | Brad |
|---|---|---|
| true | memory-creation queries for every user on the server concurrently; grows with users | true |

### #629 · immich-app/immich@f7b8ae5da3 · `server/src/services/transcoding.service.ts:380`

```
378:     const cutoff = Date.now() - HLS_INACTIVITY_TIMEOUT_MS;
379:     const inactiveSessions = this.sessions.values().filter((s) => s.lastActivityTime.getTime() < cutoff);
380:     return Promise.all(
381:       inactiveSessions.map(async (session) => {
382:         try {
383:           this.websocketRepository.serverSend('HlsSessionEnd', { sessionId: session.id });
```

| Proposed | Reason | Brad |
|---|---|---|
| small | sweeps inactive HLS sessions; a few at a time | small |

### #646 · immich-app/immich@f7b8ae5da3 · `server/src/utils/maintenance.ts:35`

```
33: ): Promise<MaintenanceDetectInstallResponseDto> {
34:   return {
35:     storage: await Promise.all(
36:       Object.values(StorageFolder).map(async (folder) => {
37:         const path = StorageCore.getBaseFolder(folder);
38:         const files = await storageRepository.readdir(path);
```

| Proposed | Reason | Brad |
|---|---|---|
| wrong | Promise.all over the fixed StorageFolder enum values | wrong |

### #653 · immich-app/immich@f7b8ae5da3 · `server/src/utils/tasks.ts:11`

```
9: 
10:   async all() {
11:     await Promise.all(this.tasks.map((item) => item()));
12:   }
13: }
```

| Proposed | Reason | Brad |
|---|---|---|
| small | Tasks helper; only use (metadata.service) pushes a few tasks | small |

