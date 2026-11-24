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
-- Integrated review round 1 (H-3 remainder): the dedupe keeps the
-- earliest row, but block_id may live only on a LATER duplicate
-- (the same section first added by hand, then again from the
-- block picker). Deleting that duplicate would lose the block
-- link, and the ledger could no longer untick the block. Rescue
-- it first: a survivor with no block_id adopts one from any of
-- its duplicates before they are dropped.
UPDATE ridden_line_sections
SET block_id = (
  SELECT dup.block_id
  FROM ridden_line_sections AS dup
  WHERE dup.ridden_line_id = ridden_line_sections.ridden_line_id
    AND dup.from_station_id = ridden_line_sections.from_station_id
    AND dup.to_station_id = ridden_line_sections.to_station_id
    AND COALESCE(dup.direction, '') = COALESCE(ridden_line_sections.direction, '')
    AND dup.block_id IS NOT NULL
  ORDER BY dup.id
  LIMIT 1
)
WHERE block_id IS NULL
  AND id IN (
    SELECT MIN(id)
    FROM ridden_line_sections
    GROUP BY ridden_line_id, from_station_id, to_station_id, COALESCE(direction, '')
  )
  AND EXISTS (
    SELECT 1
    FROM ridden_line_sections AS dup
    WHERE dup.ridden_line_id = ridden_line_sections.ridden_line_id
      AND dup.from_station_id = ridden_line_sections.from_station_id
      AND dup.to_station_id = ridden_line_sections.to_station_id
      AND COALESCE(dup.direction, '') = COALESCE(ridden_line_sections.direction, '')
      AND dup.block_id IS NOT NULL
  );
--> statement-breakpoint
DELETE FROM ridden_line_sections
WHERE id NOT IN (
  SELECT MIN(id)
  FROM ridden_line_sections
  GROUP BY ridden_line_id, from_station_id, to_station_id, COALESCE(direction, '')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ridden_line_sections_unique_section`
  ON `ridden_line_sections` (ridden_line_id, from_station_id, to_station_id, COALESCE(direction, ''));
