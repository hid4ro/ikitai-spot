-- Existing rows keep their saved IDs and ride details. The old writers did
-- not record how an ID was chosen, so their provenance remains unknown.
ALTER TABLE `ridden_lines` ADD COLUMN `service_link_source` text
  CHECK (`service_link_source` IN ('auto', 'explicit'));
--> statement-breakpoint
ALTER TABLE `ridden_lines` ADD COLUMN `service_match_version` text;
