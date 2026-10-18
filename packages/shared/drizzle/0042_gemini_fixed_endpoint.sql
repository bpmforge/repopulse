-- W19-07: the W19-01 migration added the `gemini` kind (a vendor with a FIXED
-- endpoint, so no base URL is stored) but left this constraint listing only the
-- other fixed-endpoint kinds. A Gemini connection created from the admin screen,
-- which hides the base-URL field for such vendors, failed with a constraint
-- violation. Found by creating one through the real route.
ALTER TABLE "llm_providers" DROP CONSTRAINT "llm_providers_base_url_check";--> statement-breakpoint
ALTER TABLE "llm_providers" ADD CONSTRAINT "llm_providers_base_url_check" CHECK (base_url is not null or kind in ('anthropic', 'gemini', 'bedrock', 'copilot', 'openai_subscription'));
