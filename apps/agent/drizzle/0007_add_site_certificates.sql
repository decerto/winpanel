CREATE TABLE `site_certificates` (
	`site_id` text PRIMARY KEY NOT NULL,
	`certificate` text NOT NULL,
	`subjects` text DEFAULT '[]' NOT NULL,
	`issuer` text NOT NULL,
	`not_before` integer NOT NULL,
	`not_after` integer NOT NULL,
	`uploaded_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
