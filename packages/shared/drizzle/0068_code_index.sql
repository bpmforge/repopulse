-- Migration 0068 (W22-01): the code map.
--
-- WHY. The owner chose decision 4 on 2026-11-05 ("names and lines only"): keep,
-- per repository, the symbol graph Lodestone extracts from the scan snapshot,
-- so triage, the hunt and the learning loop can ask "who calls X" after the
-- snapshot is gone (C1a). NAMES, LINE SPANS, HASHES AND EDGES ONLY: no column
-- here holds source text.
--
-- ONE MAP PER REPOSITORY (unique workspace_id, repo_id), replaced when a newer
-- commit is indexed; the child rows go with it (ON DELETE CASCADE).
--
-- TENANCY. workspace_id NOT NULL on all six tables, leading every index.
--
-- ROLLBACK. DROP TABLE the five children, then "code_indexes"; the map is
-- derived data and the next scan builds it again.
CREATE TABLE "code_indexes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "code_indexes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"repo_id" bigint NOT NULL,
	"commit_sha" text NOT NULL,
	"extractor" text NOT NULL,
	"file_count" integer NOT NULL,
	"def_count" integer NOT NULL,
	"ref_count" integer NOT NULL,
	"call_count" integer NOT NULL,
	"import_count" integer NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"build_ms" integer NOT NULL,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "code_indexes_ws_repo_uniq" UNIQUE("workspace_id","repo_id")
);
--> statement-breakpoint
CREATE TABLE "code_index_files" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "code_index_files_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"index_id" bigint NOT NULL,
	"path" text NOT NULL,
	"content_hash" text NOT NULL,
	"language" text,
	"method" text NOT NULL,
	"line_count" integer NOT NULL,
	CONSTRAINT "code_index_files_path_uniq" UNIQUE("workspace_id","index_id","path")
);
--> statement-breakpoint
CREATE TABLE "code_index_defs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "code_index_defs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"index_id" bigint NOT NULL,
	"path" text NOT NULL,
	"symbol" text NOT NULL,
	"kind" text NOT NULL,
	"start_line" integer NOT NULL,
	"end_line" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "code_index_refs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "code_index_refs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"index_id" bigint NOT NULL,
	"path" text NOT NULL,
	"symbol" text NOT NULL,
	"lines" integer[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "code_index_calls" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "code_index_calls_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"index_id" bigint NOT NULL,
	"path" text NOT NULL,
	"caller" text NOT NULL,
	"callee" text NOT NULL,
	"line" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "code_index_imports" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "code_index_imports_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" bigint NOT NULL,
	"index_id" bigint NOT NULL,
	"path" text NOT NULL,
	"target" text NOT NULL,
	"line" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "code_indexes" ADD CONSTRAINT "code_indexes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_indexes" ADD CONSTRAINT "code_indexes_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_index_files" ADD CONSTRAINT "code_index_files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_index_files" ADD CONSTRAINT "code_index_files_index_id_code_indexes_id_fk" FOREIGN KEY ("index_id") REFERENCES "public"."code_indexes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_index_defs" ADD CONSTRAINT "code_index_defs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_index_defs" ADD CONSTRAINT "code_index_defs_index_id_code_indexes_id_fk" FOREIGN KEY ("index_id") REFERENCES "public"."code_indexes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_index_refs" ADD CONSTRAINT "code_index_refs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_index_refs" ADD CONSTRAINT "code_index_refs_index_id_code_indexes_id_fk" FOREIGN KEY ("index_id") REFERENCES "public"."code_indexes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_index_calls" ADD CONSTRAINT "code_index_calls_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_index_calls" ADD CONSTRAINT "code_index_calls_index_id_code_indexes_id_fk" FOREIGN KEY ("index_id") REFERENCES "public"."code_indexes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_index_imports" ADD CONSTRAINT "code_index_imports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_index_imports" ADD CONSTRAINT "code_index_imports_index_id_code_indexes_id_fk" FOREIGN KEY ("index_id") REFERENCES "public"."code_indexes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "code_index_defs_symbol_idx" ON "code_index_defs" USING btree ("workspace_id","index_id","symbol");--> statement-breakpoint
CREATE INDEX "code_index_defs_path_idx" ON "code_index_defs" USING btree ("workspace_id","index_id","path");--> statement-breakpoint
CREATE INDEX "code_index_refs_symbol_idx" ON "code_index_refs" USING btree ("workspace_id","index_id","symbol");--> statement-breakpoint
CREATE INDEX "code_index_calls_callee_idx" ON "code_index_calls" USING btree ("workspace_id","index_id","callee");--> statement-breakpoint
CREATE INDEX "code_index_calls_caller_idx" ON "code_index_calls" USING btree ("workspace_id","index_id","caller");--> statement-breakpoint
CREATE INDEX "code_index_imports_path_idx" ON "code_index_imports" USING btree ("workspace_id","index_id","path");
