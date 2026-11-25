-- Keep the service that supplied the ride independently of the active link.
ALTER TABLE `ridden_lines` ADD COLUMN `recorded_service_id` text;
--> statement-breakpoint
ALTER TABLE `ridden_line_sections` ADD COLUMN `recorded_service_id` text;
--> statement-breakpoint
-- The 0011 restoration identifies these primary sections even if the active
-- link has changed. Match the date, endpoints and version as well as the name.
WITH restored(name, first_ridden_on, from_station_id, to_station_id, service_id) AS (
  VALUES
    ('JR中央線（快速）', '2026-11-15', '003606', '003766', 'jr-chuo-rapid'),
    ('JR総武快速線', '2026-11-15', '003766', '004173', 'jr-sobu-rapid'),
    ('JR総武本線', '2026-11-16', '003531', '004173', 'jr-sobu-local'),
    ('京王線', '2026-11-22', '003821', '003971', 'keio'),
    ('JR埼京線', '2026-11-24', '003700', '004135', 'jr-saikyo'),
    ('りんかい線', '2026-11-24', '004135', '004182', 'rinkai'),
    ('山手線', '2026-11-24', '004135', '004072', 'yamanote')
)
UPDATE `ridden_lines` AS line
SET `recorded_service_id` = restored.service_id
FROM restored
WHERE line.name = restored.name
  AND line.first_ridden_on = restored.first_ridden_on
  AND line.from_station_id = restored.from_station_id
  AND line.to_station_id = restored.to_station_id
  AND line.ride_state = 'partial'
  AND line.master_version = '2026-11-24';
--> statement-breakpoint
-- Link confirmations always wrote 'explicit', as did some registrations.
-- For the remaining primary sections, only the saved link on a row that
-- has never been manually reviewed can be carried forward as the original.
UPDATE `ridden_lines`
SET `recorded_service_id` = `service_id`
WHERE `recorded_service_id` IS NULL
  AND `service_id` IS NOT NULL
  AND (`service_link_source` IS NULL OR `service_link_source` = 'auto')
  AND (`ride_state` = 'full' OR (
    `ride_state` = 'partial' AND `from_station_id` IS NOT NULL AND `to_station_id` IS NOT NULL
  ));
--> statement-breakpoint
-- A named block carries its own service evidence. Blockless sections can
-- inherit the parent link only when it has never been manually reviewed.
UPDATE `ridden_line_sections` AS section
SET `recorded_service_id` = line.service_id
FROM `ridden_lines` AS line
WHERE section.ridden_line_id = line.id
  AND section.block_id IS NULL
  AND line.service_id IS NOT NULL
  AND (line.service_link_source IS NULL OR line.service_link_source = 'auto');
