UPDATE spots SET category = '行ってみたい' WHERE category IS NULL OR trim(category) = '';
