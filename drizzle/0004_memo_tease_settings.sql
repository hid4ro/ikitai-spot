ALTER TABLE settings ADD COLUMN memo_tease_enabled INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE settings ADD COLUMN memo_tease_template TEXT NOT NULL DEFAULT '「{メモ}」って書いてあったけど、こんなの気になっちゃってるの〜？ざぁこ♡';
