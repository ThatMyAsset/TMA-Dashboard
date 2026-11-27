CREATE INDEX IF NOT EXISTS devices_policy_version_idx ON devices (policy_version);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'devices_policy_version_fkey'
    ) THEN
        ALTER TABLE devices
            ADD CONSTRAINT devices_policy_version_fkey
            FOREIGN KEY (policy_version) REFERENCES policies(id)
            ON UPDATE CASCADE ON DELETE RESTRICT;
    END IF;
END $$;
