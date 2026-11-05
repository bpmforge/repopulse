import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  boolean,
} from 'drizzle-orm/pg-core';
import { workspaces } from '../core/workspaces.js';
import { repos } from '../core/repos.js';

// The code map (W22-01, owner's decision 4, 2026-11-05: "names and lines only").
//
// Built by Lodestone's graph extractor (@bpmforge/lodestone/graph) from the scan
// snapshot while it exists (C1a), and kept after the snapshot is deleted. It
// holds NAMES, LINE SPANS, HASHES AND EDGES, NEVER CODE: a symbol name, the file
// path it is in, the lines it spans, which name calls which, which file imports
// which module, and a sha256 per file. No line of source text is stored here;
// packets that need code are cut from the snapshot at scan time (W22-02).
//
// ONE MAP PER REPOSITORY, replaced when a newer commit is indexed: the rows of
// the old map go with its code_indexes row (ON DELETE CASCADE). Every table
// carries workspace_id and leads its indexes with it (Law 5).

export const codeIndexes = pgTable(
  'code_indexes',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    repoId: bigint('repo_id', { mode: 'number' })
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    commitSha: text('commit_sha').notNull(),
    /** "lodestone@<commit>": which extractor produced it. */
    extractor: text('extractor').notNull(),
    fileCount: integer('file_count').notNull(),
    defCount: integer('def_count').notNull(),
    refCount: integer('ref_count').notNull(),
    callCount: integer('call_count').notNull(),
    importCount: integer('import_count').notNull(),
    /** True when a cap stopped the walk or a table; the counts say what was kept. */
    truncated: boolean('truncated').notNull().default(false),
    buildMs: integer('build_ms').notNull(),
    builtAt: timestamp('built_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('code_indexes_ws_repo_uniq').on(t.workspaceId, t.repoId)],
);

const parent = () =>
  bigint('index_id', { mode: 'number' })
    .notNull()
    .references(() => codeIndexes.id, { onDelete: 'cascade' });
const ws = () =>
  bigint('workspace_id', { mode: 'number' })
    .notNull()
    .references(() => workspaces.id);

/** One row per indexed file: path, content hash, language, which tier read it. */
export const codeIndexFiles = pgTable(
  'code_index_files',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: ws(),
    indexId: parent(),
    path: text('path').notNull(),
    /** sha256 of the file's bytes at the indexed commit. */
    contentHash: text('content_hash').notNull(),
    language: text('language'),
    /** 'tree-sitter' or 'regex' (Lodestone's tier for this file). */
    method: text('method').notNull(),
    lineCount: integer('line_count').notNull(),
  },
  (t) => [unique('code_index_files_path_uniq').on(t.workspaceId, t.indexId, t.path)],
);

/** A definition: name, kind and the lines it spans. */
export const codeIndexDefs = pgTable(
  'code_index_defs',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: ws(),
    indexId: parent(),
    path: text('path').notNull(),
    symbol: text('symbol').notNull(),
    kind: text('kind').notNull(),
    startLine: integer('start_line').notNull(),
    endLine: integer('end_line').notNull(),
  },
  (t) => [
    index('code_index_defs_symbol_idx').on(t.workspaceId, t.indexId, t.symbol),
    index('code_index_defs_path_idx').on(t.workspaceId, t.indexId, t.path),
  ],
);

/**
 * References to a name the repository itself defines, one row per (file,
 * name) with every line it appears on. A reference to a name defined nowhere
 * in the repository (a library call, a local variable) is not kept: it
 * answers no "who uses X" question and was ~2/3 of the raw rows.
 */
export const codeIndexRefs = pgTable(
  'code_index_refs',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: ws(),
    indexId: parent(),
    path: text('path').notNull(),
    symbol: text('symbol').notNull(),
    lines: integer('lines').array().notNull(),
  },
  (t) => [index('code_index_refs_symbol_idx').on(t.workspaceId, t.indexId, t.symbol)],
);

/** A call edge: caller name -> callee name at a line. Callees defined in the repo only. */
export const codeIndexCalls = pgTable(
  'code_index_calls',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: ws(),
    indexId: parent(),
    path: text('path').notNull(),
    caller: text('caller').notNull(),
    callee: text('callee').notNull(),
    line: integer('line').notNull(),
  },
  (t) => [
    index('code_index_calls_callee_idx').on(t.workspaceId, t.indexId, t.callee),
    index('code_index_calls_caller_idx').on(t.workspaceId, t.indexId, t.caller),
  ],
);

/** An import edge: file -> the module or relative path it names. */
export const codeIndexImports = pgTable(
  'code_index_imports',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: ws(),
    indexId: parent(),
    path: text('path').notNull(),
    target: text('target').notNull(),
    line: integer('line').notNull(),
  },
  (t) => [index('code_index_imports_path_idx').on(t.workspaceId, t.indexId, t.path)],
);
