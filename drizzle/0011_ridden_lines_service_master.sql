-- Stage 1 of the service-master migration (subtask 1420): the
-- ridden-lines ledger gains the ride state and the restored section.
-- ride_state is 'unknown' | 'partial' | 'full' (see
-- shared/service-master.ts): unknown means the record pins down no
-- section, partial means the from/to stations below are the section
-- actually ridden, full means the whole service. Stations are N02
-- station group codes (N02_005g) with their names alongside.
-- service_id links the row to its service-master entry; master_version
-- records the master version the ride was cut at (full rides keep
-- theirs, so a later extension never claims an unridden stretch).
ALTER TABLE `ridden_lines` ADD COLUMN `service_id` text;
--> statement-breakpoint
ALTER TABLE `ridden_lines` ADD COLUMN `ride_state` text DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
ALTER TABLE `ridden_lines` ADD COLUMN `from_station_id` text;
--> statement-breakpoint
ALTER TABLE `ridden_lines` ADD COLUMN `from_station_name` text;
--> statement-breakpoint
ALTER TABLE `ridden_lines` ADD COLUMN `to_station_id` text;
--> statement-breakpoint
ALTER TABLE `ridden_lines` ADD COLUMN `to_station_name` text;
--> statement-breakpoint
ALTER TABLE `ridden_lines` ADD COLUMN `master_version` text;
--> statement-breakpoint
-- Backfill the nine live ledger rows from MIGRATED_RIDES
-- (shared/service-master.ts). Sections restored from the trip
-- context and delivery note recorded at the time; the two rides
-- with no section on record stay unknown.
-- Each UPDATE identifies its legacy row by name AND first-ride
-- date (a later row with the same name must never inherit the
-- section), and only touches rows that are still unlinked
-- (service_id IS NULL — and, for partial rides, with no section
-- yet), so re-running the migration never overwrites a section a
-- caller recorded explicitly.
UPDATE `ridden_lines` SET `service_id` = 'jr-musashino', `master_version` = '2026-11-24' WHERE `name` = 'JR武蔵野線' AND `first_ridden_on` = '2026-11-12' AND `service_id` IS NULL;
--> statement-breakpoint
UPDATE `ridden_lines` SET `service_id` = 'hokuso', `master_version` = '2026-11-24' WHERE `name` = '北総線' AND `first_ridden_on` = '2026-11-12' AND `service_id` IS NULL;
--> statement-breakpoint
UPDATE `ridden_lines` SET `service_id` = 'jr-chuo-rapid', `ride_state` = 'partial', `from_station_id` = '003606', `from_station_name` = '国分寺', `to_station_id` = '003766', `to_station_name` = '東京', `master_version` = '2026-11-24' WHERE `name` = 'JR中央線（快速）' AND `first_ridden_on` = '2026-11-15' AND `service_id` IS NULL AND `from_station_id` IS NULL AND `to_station_id` IS NULL;
--> statement-breakpoint
UPDATE `ridden_lines` SET `service_id` = 'jr-sobu-rapid', `ride_state` = 'partial', `from_station_id` = '003766', `from_station_name` = '東京', `to_station_id` = '004173', `to_station_name` = '千葉', `master_version` = '2026-11-24' WHERE `name` = 'JR総武快速線' AND `first_ridden_on` = '2026-11-15' AND `service_id` IS NULL AND `from_station_id` IS NULL AND `to_station_id` IS NULL;
--> statement-breakpoint
UPDATE `ridden_lines` SET `service_id` = 'jr-sobu-local', `ride_state` = 'partial', `from_station_id` = '003531', `from_station_name` = '佐倉', `to_station_id` = '004173', `to_station_name` = '千葉', `master_version` = '2026-11-24' WHERE `name` = 'JR総武本線' AND `first_ridden_on` = '2026-11-16' AND `service_id` IS NULL AND `from_station_id` IS NULL AND `to_station_id` IS NULL;
--> statement-breakpoint
UPDATE `ridden_lines` SET `service_id` = 'keio', `ride_state` = 'partial', `from_station_id` = '003821', `from_station_name` = '府中', `to_station_id` = '003971', `to_station_name` = '聖蹟桜ヶ丘', `master_version` = '2026-11-24' WHERE `name` = '京王線' AND `first_ridden_on` = '2026-11-22' AND `service_id` IS NULL AND `from_station_id` IS NULL AND `to_station_id` IS NULL;
--> statement-breakpoint
UPDATE `ridden_lines` SET `service_id` = 'jr-saikyo', `ride_state` = 'partial', `from_station_id` = '003700', `from_station_name` = '新宿', `to_station_id` = '004135', `to_station_name` = '大崎', `master_version` = '2026-11-24' WHERE `name` = 'JR埼京線' AND `first_ridden_on` = '2026-11-24' AND `service_id` IS NULL AND `from_station_id` IS NULL AND `to_station_id` IS NULL;
--> statement-breakpoint
UPDATE `ridden_lines` SET `service_id` = 'rinkai', `ride_state` = 'partial', `from_station_id` = '004135', `from_station_name` = '大崎', `to_station_id` = '004182', `to_station_name` = '品川シーサイド', `master_version` = '2026-11-24' WHERE `name` = 'りんかい線' AND `first_ridden_on` = '2026-11-24' AND `service_id` IS NULL AND `from_station_id` IS NULL AND `to_station_id` IS NULL;
--> statement-breakpoint
UPDATE `ridden_lines` SET `service_id` = 'yamanote', `ride_state` = 'partial', `from_station_id` = '004135', `from_station_name` = '大崎', `to_station_id` = '004072', `to_station_name` = '目黒', `master_version` = '2026-11-24' WHERE `name` = '山手線' AND `first_ridden_on` = '2026-11-24' AND `service_id` IS NULL AND `from_station_id` IS NULL AND `to_station_id` IS NULL;
