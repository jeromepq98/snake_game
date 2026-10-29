-- Custom snake head pictures. One image per guest, always stored as PNG.
-- The version column is a content token used for cache-busting image URLs.

CREATE TABLE player_heads (
  guest_id VARCHAR(40) NOT NULL,
  mime VARCHAR(32) NOT NULL DEFAULT 'image/png',
  image MEDIUMBLOB NOT NULL,
  version CHAR(16) NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (guest_id),
  CONSTRAINT fk_heads_guest FOREIGN KEY (guest_id) REFERENCES guest_players (guest_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
