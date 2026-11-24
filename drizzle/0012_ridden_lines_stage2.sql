-- Stage 2 of the service-master migration (subtask 1421): a full
-- ride keeps the versioned path it was cut at, and a ride gains
-- extra sections (block picks) beyond its primary section.
-- path_snapshot is the JSON of the FullPathSnapshot
-- (shared/service-master.ts): the path id, the master version it
-- was cut at, and the segment list as it stood then. A later
-- master change never rewrites a stored snapshot, so a past full
-- ride keeps reproducing the range it was recorded at. Null for
-- partial / unknown rides, and for full rides recorded before
-- stage 2 (whose range the current master reproduces — the
-- client falls back to it when the snapshot is absent).
ALTER TABLE `ridden_lines` ADD COLUMN `path_snapshot` text;
--> statement-breakpoint
-- One row per added section: a block pick, or a hand-entered
-- section between two boundary stations of the row's service.
-- The station pair is the saved record; the geometry and the
-- distance are derived at draw time. direction is 'inner' |
-- 'outer' on a loop service, null elsewhere. block_id names the
-- master block the section covers, when the section is exactly
-- one block — the client uses it to mark the block covered.
-- Rows are deleted with their ledger row: the delete action
-- removes them explicitly (SQLite foreign keys are not enforced
-- by the runtime, so no REFERENCES clause is relied on).
CREATE TABLE `ridden_line_sections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ridden_line_id` integer NOT NULL,
	`from_station_id` text NOT NULL,
	`from_station_name` text,
	`to_station_id` text NOT NULL,
	`to_station_name` text,
	`direction` text,
	`block_id` text,
	`created_at` integer NOT NULL
);
