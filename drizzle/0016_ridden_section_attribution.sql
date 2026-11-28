-- Keep the original recording service when a later add confirms the same section for another service.
ALTER TABLE `ridden_line_sections` ADD COLUMN `attributed_service_id` text;
