ALTER TABLE pairing_codes ADD COLUMN code_ciphertext BYTEA;
-- Codes created by older versions were hash-only and cannot be recovered safely.
UPDATE pairing_codes SET used_at = now() WHERE used_at IS NULL;
