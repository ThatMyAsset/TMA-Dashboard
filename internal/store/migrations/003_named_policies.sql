UPDATE policies
SET document = jsonb_set(
    document,
    '{name}',
    to_jsonb('Policy ' || left(id::text, 8)),
    true
)
WHERE NOT (document ? 'name') OR COALESCE(document->>'name', '') = '';
