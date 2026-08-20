CREATE TABLE "eol_products" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "eol_products_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"product" text NOT NULL,
	"cycle" text NOT NULL,
	"eol_date" timestamp with time zone,
	"support_until" timestamp with time zone,
	"latest_version" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eol_products_product_cycle_key" UNIQUE("product","cycle")
);
--> statement-breakpoint
CREATE TABLE "release_meta" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "release_meta_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"ecosystem" text NOT NULL,
	"package" text NOT NULL,
	"latest_version" text,
	"latest_release_at" timestamp with time zone,
	"deprecated" boolean DEFAULT false NOT NULL,
	"yanked" boolean,
	"license" text,
	"version_dates" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "release_meta_ecosystem_package_key" UNIQUE("ecosystem","package"),
	CONSTRAINT "release_meta_ecosystem_check" CHECK ("release_meta"."ecosystem" in ('npm', 'pypi'))
);
