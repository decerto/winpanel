ALTER TABLE `hosted_databases` ADD `network_mode` text DEFAULT 'loopback' NOT NULL;--> statement-breakpoint
ALTER TABLE `hosted_databases` ADD `network_cidrs` text DEFAULT '[]' NOT NULL;
