CREATE TABLE `visited_municipalities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`prefecture` text NOT NULL,
	`area` text,
	`visited_on` text NOT NULL,
	`lat` real,
	`lng` real,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `visited_municipalities_pref_name` ON `visited_municipalities` (`prefecture`,`name`);
