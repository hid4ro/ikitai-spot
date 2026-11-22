CREATE TABLE `ridden_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`first_ridden_on` text NOT NULL,
	`note` text,
	`created_at` integer NOT NULL
);
