-- W23-06 (2026-10-31): record prompt-cache hits per analysis run so the Models
-- page can show a cache-hit % per model.
--
-- analysis_runs.cache_read_tokens: input tokens the provider served from its
-- prompt cache across the run's calls (claude-cli cache_read_input_tokens,
-- OpenAI-compatible usage.prompt_tokens_details.cached_tokens, Anthropic
-- cache_read_input_tokens). Already counted inside prompt_tokens. 0 for
-- providers that report nothing and for every row written before this column.
ALTER TABLE "analysis_runs" ADD COLUMN "cache_read_tokens" integer DEFAULT 0 NOT NULL;
