CREATE TABLE `hosted_databases` (
	`id` text PRIMARY KEY NOT NULL,
	`engine` text NOT NULL,
	`name` text NOT NULL,
	`username` text NOT NULL,
	`site_id` text,
	`owner_user_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hosted_databases_engine_name_idx` ON `hosted_databases` (`engine`,`name`);--> statement-breakpoint
CREATE INDEX `hosted_databases_owner_idx` ON `hosted_databases` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `hosted_databases_site_idx` ON `hosted_databases` (`site_id`);--> statement-breakpoint
ALTER TABLE `users` ADD `database_limit` integer;
