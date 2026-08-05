PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`totp_secret` text,
	`totp_pending_secret` text,
	`totp_enrolled` integer DEFAULT false NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`site_limit` integer,
	`mail_quota_bytes` integer,
	`site_disk_quota_bytes` integer,
	`created_by` text,
	`last_login_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "username", "password_hash", "role", "totp_secret", "totp_pending_secret", "totp_enrolled", "disabled", "site_limit", "mail_quota_bytes", "site_disk_quota_bytes", "created_by", "last_login_at", "created_at", "updated_at") SELECT "id", "username", "password_hash", CASE "role" WHEN 'owner' THEN 'superadmin' ELSE "role" END, "totp_secret", "totp_pending_secret", "totp_enrolled", "disabled", NULL, NULL, NULL, NULL, "last_login_at", "created_at", "updated_at" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_idx` ON `users` (`username`);--> statement-breakpoint
ALTER TABLE `sites` ADD `owner_user_id` text REFERENCES users(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `sites_owner_idx` ON `sites` (`owner_user_id`);
