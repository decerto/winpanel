CREATE TABLE `backup_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`site_id` text REFERENCES sites(id) ON DELETE CASCADE,
	`owner_user_id` text REFERENCES users(id) ON DELETE CASCADE,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `backup_uploads_expiry_idx` ON `backup_uploads` (`expires_at`);