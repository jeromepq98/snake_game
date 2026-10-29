-- Snake Arena initial schema.
-- All player data belongs to anonymous guests identified by opaque guest IDs.
-- Nicknames are display names only, never identities.

CREATE TABLE guest_players (
  guest_id VARCHAR(40) NOT NULL,
  nickname VARCHAR(24) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  nickname_updated_at DATETIME NULL,
  PRIMARY KEY (guest_id),
  KEY idx_guests_last_seen (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE player_sessions (
  token_hash CHAR(64) NOT NULL,
  guest_id VARCHAR(40) NOT NULL,
  ip_hash CHAR(64) NOT NULL DEFAULT '',
  user_agent VARCHAR(255) NOT NULL DEFAULT '',
  room_id VARCHAR(24) NULL,
  player_id INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  PRIMARY KEY (token_hash),
  KEY idx_sessions_guest (guest_id),
  KEY idx_sessions_expires (expires_at),
  CONSTRAINT fk_sessions_guest FOREIGN KEY (guest_id) REFERENCES guest_players (guest_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE matches (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  mode VARCHAR(16) NOT NULL,
  map VARCHAR(16) NOT NULL,
  room_code VARCHAR(8) NULL,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at DATETIME NULL,
  player_count INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_matches_started (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE match_players (
  match_id BIGINT UNSIGNED NOT NULL,
  guest_id VARCHAR(40) NOT NULL,
  nickname VARCHAR(24) NOT NULL,
  score INT NOT NULL DEFAULT 0,
  kills INT NOT NULL DEFAULT 0,
  deaths INT NOT NULL DEFAULT 0,
  survived_seconds INT NOT NULL DEFAULT 0,
  won TINYINT(1) NOT NULL DEFAULT 0,
  joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (match_id, guest_id),
  KEY idx_match_players_guest (guest_id),
  CONSTRAINT fk_mp_match FOREIGN KEY (match_id) REFERENCES matches (id) ON DELETE CASCADE,
  CONSTRAINT fk_mp_guest FOREIGN KEY (guest_id) REFERENCES guest_players (guest_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE leaderboard_entries (
  period ENUM('daily','weekly','alltime') NOT NULL,
  period_key VARCHAR(10) NOT NULL,
  guest_id VARCHAR(40) NOT NULL,
  nickname VARCHAR(24) NOT NULL,
  best_score INT NOT NULL DEFAULT 0,
  kills INT NOT NULL DEFAULT 0,
  wins INT NOT NULL DEFAULT 0,
  matches INT NOT NULL DEFAULT 0,
  suspicious TINYINT(1) NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (period, period_key, guest_id),
  KEY idx_lb_rank (period, period_key, best_score DESC),
  KEY idx_lb_guest (guest_id),
  CONSTRAINT fk_lb_guest FOREIGN KEY (guest_id) REFERENCES guest_players (guest_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE player_statistics (
  guest_id VARCHAR(40) NOT NULL,
  nickname VARCHAR(24) NOT NULL,
  highest_score INT NOT NULL DEFAULT 0,
  total_kills INT NOT NULL DEFAULT 0,
  total_deaths INT NOT NULL DEFAULT 0,
  longest_survival_seconds INT NOT NULL DEFAULT 0,
  wins INT NOT NULL DEFAULT 0,
  matches_played INT NOT NULL DEFAULT 0,
  suspicious_flags INT NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (guest_id),
  KEY idx_stats_highest (highest_score DESC),
  CONSTRAINT fk_stats_guest FOREIGN KEY (guest_id) REFERENCES guest_players (guest_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE player_skins (
  guest_id VARCHAR(40) NOT NULL,
  skin_id VARCHAR(16) NOT NULL,
  unlocked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (guest_id, skin_id),
  CONSTRAINT fk_skins_guest FOREIGN KEY (guest_id) REFERENCES guest_players (guest_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE achievements (
  id VARCHAR(32) NOT NULL,
  name VARCHAR(48) NOT NULL,
  description VARCHAR(160) NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE player_achievements (
  guest_id VARCHAR(40) NOT NULL,
  achievement_id VARCHAR(32) NOT NULL,
  unlocked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (guest_id, achievement_id),
  KEY idx_pach_guest (guest_id),
  CONSTRAINT fk_pach_guest FOREIGN KEY (guest_id) REFERENCES guest_players (guest_id) ON DELETE CASCADE,
  CONSTRAINT fk_pach_ach FOREIGN KEY (achievement_id) REFERENCES achievements (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE player_blocks (
  blocker_guest_id VARCHAR(40) NOT NULL,
  blocked_guest_id VARCHAR(40) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (blocker_guest_id, blocked_guest_id),
  KEY idx_blocks_blocker (blocker_guest_id),
  CONSTRAINT fk_blocks_blocker FOREIGN KEY (blocker_guest_id) REFERENCES guest_players (guest_id) ON DELETE CASCADE,
  CONSTRAINT fk_blocks_blocked FOREIGN KEY (blocked_guest_id) REFERENCES guest_players (guest_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE player_reports (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  reporter_guest_id VARCHAR(40) NOT NULL,
  reported_guest_id VARCHAR(40) NOT NULL,
  reason VARCHAR(32) NOT NULL,
  details VARCHAR(500) NOT NULL DEFAULT '',
  status ENUM('open','reviewed','actioned','dismissed') NOT NULL DEFAULT 'open',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_reports_status (status),
  KEY idx_reports_reported (reported_guest_id),
  CONSTRAINT fk_reports_reporter FOREIGN KEY (reporter_guest_id) REFERENCES guest_players (guest_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE voice_preferences (
  guest_id VARCHAR(40) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  push_to_talk TINYINT(1) NOT NULL DEFAULT 0,
  proximity TINYINT(1) NOT NULL DEFAULT 0,
  output_volume INT NOT NULL DEFAULT 80,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (guest_id),
  CONSTRAINT fk_voice_guest FOREIGN KEY (guest_id) REFERENCES guest_players (guest_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor VARCHAR(48) NOT NULL,
  action VARCHAR(32) NOT NULL,
  target_guest_id VARCHAR(40) NULL,
  details VARCHAR(500) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_created (created_at),
  KEY idx_audit_action (action)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Bans intentionally have no FK to guest_players so they outlive guest deletion.
CREATE TABLE admin_bans (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  guest_id VARCHAR(40) NOT NULL,
  reason VARCHAR(200) NOT NULL DEFAULT '',
  until DATETIME NULL,
  created_by VARCHAR(48) NOT NULL DEFAULT 'admin',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lifted_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_bans_guest (guest_id),
  KEY idx_bans_until (until)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO achievements (id, name, description) VALUES
  ('first_bite', 'First Bite', 'Eat your first food.'),
  ('golden_5', 'Gold Rush', 'Eat 5 golden apples in one match.'),
  ('score_50', 'Half Century', 'Score 50 in a single round or session.'),
  ('score_200', 'Double Century', 'Score 200 in a single round or session.'),
  ('first_kill', 'Hunter', 'Eliminate your first rival.'),
  ('kills_25', 'Apex Predator', '25 career eliminations.'),
  ('survive_180', 'Marathon', 'Survive 3 minutes on one life.'),
  ('win_1', 'Champion', 'Win a round.'),
  ('matches_10', 'Regular', 'Play 10 matches.'),
  ('powers_10', 'Collector', 'Grab 10 power-ups in one match.')
ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description);
