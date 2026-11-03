ALTER TABLE "projects" ADD COLUMN "logo_url" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "provider_avatar_url" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_custom" boolean DEFAULT false NOT NULL;--> statement-breakpoint
update users set provider_avatar_url = avatar_url;
