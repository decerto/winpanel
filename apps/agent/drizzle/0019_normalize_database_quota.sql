ALTER TABLE `users` ADD `database_quota_bytes_new` integer;
--> statement-breakpoint
UPDATE `users`
SET `database_quota_bytes_new` = NULLIF(`database_quota_bytes`, 0);
--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `database_quota_bytes`;
--> statement-breakpoint
ALTER TABLE `users` RENAME COLUMN `database_quota_bytes_new` TO `database_quota_bytes`;