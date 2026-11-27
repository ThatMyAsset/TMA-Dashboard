-- Repair databases that marked migration 003 as applied while the duplicate
-- 003_named_policies migration shadowed the pairing-code display migration.
ALTER TABLE pairing_codes ADD COLUMN IF NOT EXISTS code_ciphertext BYTEA;
UPDATE pairing_codes SET used_at = now() WHERE used_at IS NULL AND code_ciphertext IS NULL;

UPDATE policies
SET document = jsonb_set(
    document,
    '{name}',
    to_jsonb('Policy ' || left(id::text, 8)),
    true
)
WHERE NOT (document ? 'name') OR COALESCE(document->>'name', '') = '';
