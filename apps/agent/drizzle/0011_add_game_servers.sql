ALTER TABLE `users` ADD `game_server_limit` integer;
--> statement-breakpoint
ALTER TABLE `users` ADD `game_server_providers` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
CREATE TABLE `game_servers` (
  `id` text PRIMARY KEY NOT NULL,
  `slug` text NOT NULL,
  `display_name` text NOT NULL,
  `owner_user_id` text REFERENCES `users`(`id`) ON DELETE SET NULL,
  `catalog_id` text NOT NULL,
  `version` text,
  `state` text DEFAULT 'uninstalled' NOT NULL,
  `install_path` text NOT NULL,
  `data_path` text NOT NULL,
  `disk_quota_bytes` integer DEFAULT 53687091200 NOT NULL,
  `service_id` text,
  `eula_accepted` integer DEFAULT false NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `game_servers_slug_idx` ON `game_servers` (`slug`);
--> statement-breakpoint
CREATE INDEX `game_servers_owner_idx` ON `game_servers` (`owner_user_id`);
--> statement-breakpoint
CREATE TABLE `game_server_ports` (
  `id` text PRIMARY KEY NOT NULL,
  `game_server_id` text NOT NULL REFERENCES `game_servers`(`id`) ON DELETE CASCADE,
  `name` text NOT NULL,
  `protocol` text NOT NULL,
  `purpose` text NOT NULL,
  `visibility` text NOT NULL,
  `port` integer NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `game_server_ports_protocol_port_idx` ON `game_server_ports` (`protocol`, `port`);
--> statement-breakpoint
CREATE INDEX `game_server_ports_server_idx` ON `game_server_ports` (`game_server_id`);
--> statement-breakpoint
CREATE TABLE `game_server_access` (
  `game_server_id` text NOT NULL REFERENCES `game_servers`(`id`) ON DELETE CASCADE,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  PRIMARY KEY(`game_server_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `game_server_access_user_idx` ON `game_server_access` (`user_id`);
--> statement-breakpoint
ALTER TABLE `jobs` ADD `game_server_id` text;
--> statement-breakpoint
CREATE INDEX `jobs_game_server_idx` ON `jobs` (`game_server_id`);
