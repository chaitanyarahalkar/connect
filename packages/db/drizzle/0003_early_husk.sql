ALTER TYPE "public"."connector_type" ADD VALUE 'snowflake';--> statement-breakpoint
ALTER TYPE "public"."secret_kind" ADD VALUE 'snowflake_private_key';--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "provider_config" jsonb;