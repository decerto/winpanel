ALTER TABLE `users` ADD `database_quota_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `hosted_databases` ADD `size_limit_bytes` integer DEFAULT 0 NOT NULL;