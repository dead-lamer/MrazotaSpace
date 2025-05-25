db.run('ALTER TABLE threads ADD COLUMN user_ip TEXT NOT NULL DEFAULT "0.0.0.0"');
