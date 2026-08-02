CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`user_id` text,
	`action` text NOT NULL,
	`target` text,
	`ip` text,
	`outcome` text NOT NULL,
	`detail` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_events_at_idx` ON `audit_events` (`at`);--> statement-breakpoint
CREATE TABLE `check_results` (
	`id` text PRIMARY KEY NOT NULL,
	`category` text NOT NULL,
	`state` text NOT NULL,
	`detail` text,
	`reason` text,
	`site_slug` text,
	`checked_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `components` (
	`id` text PRIMARY KEY NOT NULL,
	`state` text DEFAULT 'not-installed' NOT NULL,
	`installed_version` text,
	`available_version` text,
	`install_path` text,
	`service_name` text,
	`last_error` text,
	`installed_at` integer
);
--> statement-breakpoint
CREATE TABLE `deployments` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`release_id` text NOT NULL,
	`status` text NOT NULL,
	`commit` text,
	`target_colour` text NOT NULL,
	`job_id` text,
	`started_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`finished_at` integer,
	`error_message` text,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `deployments_site_started_idx` ON `deployments` (`site_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `ip_allowlist` (
	`id` text PRIMARY KEY NOT NULL,
	`cidr` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ip_bans` (
	`ip` text PRIMARY KEY NOT NULL,
	`until` integer NOT NULL,
	`reason` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `job_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`seq` integer NOT NULL,
	`at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`level` text DEFAULT 'info' NOT NULL,
	`step` text,
	`message` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `job_logs_job_seq_idx` ON `job_logs` (`job_id`,`seq`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`title` text NOT NULL,
	`progress` integer,
	`payload` text,
	`site_id` text,
	`error_message` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 1 NOT NULL,
	`cancel_requested` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`started_at` integer,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `jobs_status_created_idx` ON `jobs` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `jobs_site_idx` ON `jobs` (`site_id`);--> statement-breakpoint
CREATE TABLE `login_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ip` text NOT NULL,
	`username` text,
	`succeeded` integer NOT NULL,
	`at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `login_attempts_ip_at_idx` ON `login_attempts` (`ip`,`at`);--> statement-breakpoint
CREATE TABLE `port_allocations` (
	`port` integer PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`colour` text NOT NULL,
	`allocated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `port_allocations_site_idx` ON `port_allocations` (`site_id`);--> statement-breakpoint
CREATE TABLE `secrets` (
	`key` text PRIMARY KEY NOT NULL,
	`ciphertext` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `server_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`check_id` text NOT NULL,
	`change_type` text NOT NULL,
	`target_key` text NOT NULL,
	`previous_value` text,
	`new_value` text,
	`undone` integer DEFAULT false NOT NULL,
	`applied_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`undone_at` integer
);
--> statement-breakpoint
CREATE INDEX `server_changes_check_idx` ON `server_changes` (`check_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`ip` text,
	`user_agent` text,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sites` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`display_name` text NOT NULL,
	`runtime` text NOT NULL,
	`domains` text DEFAULT '[]' NOT NULL,
	`source` text NOT NULL,
	`manifest` text NOT NULL,
	`port_blue` integer,
	`port_green` integer,
	`active_colour` text DEFAULT 'blue' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`disk_quota_bytes` integer DEFAULT 21474836480 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sites_slug_idx` ON `sites` (`slug`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'admin' NOT NULL,
	`totp_secret` text,
	`totp_enrolled` integer DEFAULT false NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`last_login_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_idx` ON `users` (`username`);