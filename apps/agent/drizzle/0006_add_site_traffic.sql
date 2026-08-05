CREATE TABLE `site_traffic` (
	`site_id` text NOT NULL,
	`bucket_start` integer NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL,
	`bytes_in` integer DEFAULT 0 NOT NULL,
	`bytes_out` integer DEFAULT 0 NOT NULL,
	`status_2xx` integer DEFAULT 0 NOT NULL,
	`status_3xx` integer DEFAULT 0 NOT NULL,
	`status_4xx` integer DEFAULT 0 NOT NULL,
	`status_5xx` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`site_id`, `bucket_start`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `site_traffic_bucket_idx` ON `site_traffic` (`bucket_start`);--> statement-breakpoint
CREATE TABLE `traffic_cursors` (
	`path` text PRIMARY KEY NOT NULL,
	`offset` integer DEFAULT 0 NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`read_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
