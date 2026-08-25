ALTER TABLE `users` ADD `subdomain_limit` integer;
--> statement-breakpoint
ALTER TABLE `sites` ADD `parent_site_id` text REFERENCES `sites`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX `sites_parent_idx` ON `sites` (`parent_site_id`);