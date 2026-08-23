CREATE TABLE `game_server_workshop_items` (
	`id` text PRIMARY KEY NOT NULL,
	`game_server_id` text NOT NULL,
	`published_file_id` text NOT NULL,
	`title` text NOT NULL,
	`preview_url` text,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`mod_ids` text DEFAULT '[]' NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`message` text,
	`installed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`game_server_id`) REFERENCES `game_servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `game_server_workshop_items_idx` ON `game_server_workshop_items` (`game_server_id`,`published_file_id`);
