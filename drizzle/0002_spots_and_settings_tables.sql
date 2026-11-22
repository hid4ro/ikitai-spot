DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE spots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  note TEXT,
  url TEXT,
  address TEXT,
  category TEXT,
  lat REAL,
  lng REAL,
  visited INTEGER NOT NULL DEFAULT 0,
  visited_at INTEGER,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE settings (
  id INTEGER PRIMARY KEY,
  radius_m INTEGER NOT NULL DEFAULT 500
);
--> statement-breakpoint
INSERT INTO settings (id, radius_m) VALUES (1, 500);
