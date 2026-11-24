-- Stage 2 review (H-3): the same section added twice at once could
-- insert duplicate ridden_line_sections rows — the handler's
-- check-then-insert has no unique constraint behind it, and the
-- UI's busy guard only stops double taps from one client. Add a
-- unique index on the section's identity (row + station pair +
-- direction). direction is nullable, so COALESCE it: two sections
-- with no direction are the same section, and SQLite otherwise
-- treats NULLs as distinct. Drop exact duplicates first so the
-- index builds on live data that already has them (keeps the
-- earliest row; the visible state is unchanged — the client
-- already picks the first match).
DELETE FROM ridden_line_sections
WHERE id NOT IN (
  SELECT MIN(id)
  FROM ridden_line_sections
  GROUP BY ridden_line_id, from_station_id, to_station_id, COALESCE(direction, '')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ridden_line_sections_unique_section`
  ON `ridden_line_sections` (ridden_line_id, from_station_id, to_station_id, COALESCE(direction, ''));
