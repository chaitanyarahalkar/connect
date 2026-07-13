CREATE TYPE "public"."master_key_status" AS ENUM('active', 'retired');--> statement-breakpoint
CREATE TABLE "master_keys" (
	"version" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"kms_key_id" text NOT NULL,
	"wrapped_kek" text NOT NULL,
	"status" "master_key_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"retired_at" timestamp
);
