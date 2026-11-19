-- P1 executable specification: RETIREMENT SEGMENT ONLY, not migration 018.
-- Never place this in the discovered migrations directory. No model tables,
-- reservation triggers, grants, restore floor or recovery gate are installed.
-- The caller must wrap this one statement in a transaction.
DO $retirement$
DECLARE
    affected_keys bigint;
    newly_revoked_keys bigint;
BEGIN
    -- Hard guard against accidentally applying this fixture to an installation.
    IF current_database() !~ '^lp_test_[0-9a-f]{32}$' THEN
        RAISE EXCEPTION 'immutable retirement fixture requires an isolated test database';
    END IF;

    LOCK TABLE public."user" IN ACCESS EXCLUSIVE MODE;
    LOCK TABLE public.organization IN ACCESS EXCLUSIVE MODE;
    LOCK TABLE public.project IN ACCESS EXCLUSIVE MODE;
    LOCK TABLE public.member IN ACCESS EXCLUSIVE MODE;
    LOCK TABLE public.api_key IN ACCESS EXCLUSIVE MODE;
    LOCK TABLE public.artifact IN ACCESS EXCLUSIVE MODE;
    LOCK TABLE public.preview IN ACCESS EXCLUSIVE MODE;
    LOCK TABLE public.deployment IN ACCESS EXCLUSIVE MODE;
    LOCK TABLE public.deployment_event IN ACCESS EXCLUSIVE MODE;
    LOCK TABLE public.deletion_operation IN ACCESS EXCLUSIVE MODE;
    LOCK TABLE public.idempotency_key IN ACCESS EXCLUSIVE MODE;
    LOCK TABLE public.worker_heartbeat IN ACCESS EXCLUSIVE MODE;
    LOCK TABLE public.instance_state IN ACCESS EXCLUSIVE MODE;
    LOCK TABLE public.audit_event IN ACCESS EXCLUSIVE MODE;

    IF (SELECT count(*) FROM public.launchpad_migration) <> 17
       OR NOT EXISTS (
           SELECT FROM public.launchpad_migration
           WHERE name = '20261116_017_worker_heartbeat_lifecycle'
       ) THEN
        RAISE EXCEPTION 'immutable retirement fixture requires the schema-017 baseline';
    END IF;

    IF EXISTS (
        SELECT FROM public.preview
        WHERE desired_state <> 'deleted' OR deleted_at IS NULL
    ) OR EXISTS (
        SELECT FROM public.deployment
        WHERE status NOT IN ('succeeded', 'failed', 'cancelled')
           OR step_pending IS NOT NULL
           OR lease_owner IS NOT NULL
           OR lease_expires_at IS NOT NULL
    ) OR EXISTS (
        SELECT FROM public.deletion_operation
        WHERE status <> 'succeeded'
           OR step_pending IS NOT NULL
           OR lease_owner IS NOT NULL
           OR lease_expires_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'legacy previews or jobs are not settled for retirement';
    END IF;

    IF EXISTS (
        SELECT FROM public.preview WHERE app_name !~ '^lp-[a-z0-9]{10}$'
    ) THEN
        RAISE EXCEPTION 'legacy Dokku app name history is invalid';
    END IF;

    -- Preserve exact identity. Reject malformed/case-colliding history rather
    -- than silently normalizing it or discarding deleted/slug-reused records.
    IF EXISTS (
        SELECT FROM public.preview p
        WHERE p.hostname <> lower(p.hostname)
           OR length(p.hostname) > 253
           OR cardinality(string_to_array(p.hostname, '.')) < 2
           OR EXISTS (
               SELECT FROM unnest(string_to_array(p.hostname, '.')) AS label(value)
               WHERE label.value !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
           )
    ) OR EXISTS (
        SELECT lower(hostname) FROM public.preview
        GROUP BY lower(hostname) HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'legacy hostname history is not canonical or has a case collision';
    END IF;

    -- Check only names of owned PK/UNIQUE/FK/CHECK/exclusion constraints and
    -- indexes, user-trigger presence, and the event identity-sequence mapping.
    -- This is NOT a full dependency/definition/privilege inventory. Incoming
    -- FKs, views/rules/policies/publications/functions, column definitions and
    -- ownership/grants require separate P2 review. PK/UNIQUE names also name
    -- their backing indexes. PG18's NOT NULL constraints are not in this set.
    IF (
        SELECT array_agg(c.conname::text ORDER BY c.conname::text)
        FROM pg_catalog.pg_constraint c
        WHERE c.conrelid IN (
            'public.preview'::regclass, 'public.deployment'::regclass,
            'public.deployment_event'::regclass, 'public.deletion_operation'::regclass
        )
        AND c.contype IN ('p', 'u', 'f', 'c', 'x')
    ) IS DISTINCT FROM (
        SELECT array_agg(name ORDER BY name)
        FROM unnest(ARRAY[
            'preview_pkey',
            'preview_organization_id_fkey',
            'preview_created_by_fkey',
            'preview_organization_id_project_id_fkey',
            'preview_organization_id_id_active_deployment_id_fkey',
            'preview_app_name_key',
            'preview_hostname_key',
            'preview_organization_id_id_key',
            'preview_slug_check',
            'preview_app_name_check',
            'preview_hostname_check',
            'preview_desired_state_check',
            'preview_deleted_at_matches_state',
            'deployment_pkey',
            'deployment_organization_id_fkey',
            'deployment_requested_by_fkey',
            'deployment_organization_id_preview_id_fkey',
            'deployment_organization_id_artifact_id_fkey',
            'deployment_organization_id_id_key',
            'deployment_organization_id_preview_id_id_key',
            'deployment_status_check',
            'deployment_attempt_check',
            'deployment_step_done_check',
            'deployment_step_pending_check',
            'deployment_event_pkey',
            'deployment_event_organization_id_fkey',
            'deployment_event_organization_id_deployment_id_fkey',
            'deployment_event_deployment_id_seq_key',
            'deployment_event_seq_check',
            'deployment_event_level_check',
            'deployment_event_message_check',
            'deletion_operation_pkey',
            'deletion_operation_organization_id_fkey',
            'deletion_operation_requested_by_fkey',
            'deletion_operation_organization_id_preview_id_fkey',
            'deletion_operation_organization_id_id_key',
            'deletion_operation_reason_check',
            'deletion_operation_status_check',
            'deletion_operation_attempt_check',
            'deletion_operation_fence_check',
            'deletion_operation_step_done_check',
            'deletion_operation_step_pending_check'
        ]::text[]) AS expected(name)
    ) THEN
        RAISE EXCEPTION 'legacy constraint inventory differs from the reviewed baseline';
    END IF;

    IF (
        SELECT array_agg(indexname::text ORDER BY indexname::text)
        FROM pg_catalog.pg_indexes
        WHERE schemaname = 'public'
          AND tablename IN ('preview', 'deployment', 'deployment_event', 'deletion_operation')
    ) IS DISTINCT FROM (
        SELECT array_agg(name ORDER BY name)
        FROM unnest(ARRAY[
            'preview_pkey', 'preview_app_name_key', 'preview_hostname_key',
            'preview_organization_id_id_key', 'preview_project_slug_live_idx', 'preview_expiry_idx',
            'deployment_pkey', 'deployment_organization_id_id_key',
            'deployment_organization_id_preview_id_id_key',
            'deployment_one_unfinished_per_preview', 'deployment_preview_idx', 'deployment_claim_idx',
            'deployment_event_pkey', 'deployment_event_deployment_id_seq_key',
            'deletion_operation_pkey', 'deletion_operation_organization_id_id_key',
            'deletion_one_unfinished_per_preview', 'deletion_claim_idx'
        ]::text[]) AS expected(name)
    ) OR EXISTS (
        SELECT FROM pg_catalog.pg_trigger
        WHERE tgrelid IN (
            'public.preview'::regclass, 'public.deployment'::regclass,
            'public.deployment_event'::regclass, 'public.deletion_operation'::regclass
        ) AND NOT tgisinternal
    ) OR pg_catalog.pg_get_serial_sequence('public.deployment_event', 'id')
        IS DISTINCT FROM 'public.deployment_event_id_seq' THEN
        RAISE EXCEPTION 'legacy index, trigger or identity inventory differs from the reviewed baseline';
    END IF;

    ALTER TABLE public.preview RENAME TO legacy_preview;
    ALTER TABLE public.deployment RENAME TO legacy_deployment;
    ALTER TABLE public.deployment_event RENAME TO legacy_deployment_event;
    ALTER TABLE public.deletion_operation RENAME TO legacy_deletion_operation;

    ALTER TABLE public.legacy_preview RENAME CONSTRAINT preview_pkey TO legacy_preview_pkey;
    ALTER TABLE public.legacy_preview RENAME CONSTRAINT preview_organization_id_fkey TO legacy_preview_organization_id_fkey;
    ALTER TABLE public.legacy_preview RENAME CONSTRAINT preview_created_by_fkey TO legacy_preview_created_by_fkey;
    ALTER TABLE public.legacy_preview RENAME CONSTRAINT preview_organization_id_project_id_fkey TO legacy_preview_organization_id_project_id_fkey;
    ALTER TABLE public.legacy_preview RENAME CONSTRAINT preview_organization_id_id_active_deployment_id_fkey TO legacy_preview_organization_id_id_active_deployment_id_fkey;
    ALTER TABLE public.legacy_preview RENAME CONSTRAINT preview_app_name_key TO legacy_preview_app_name_key;
    ALTER TABLE public.legacy_preview RENAME CONSTRAINT preview_hostname_key TO legacy_preview_hostname_key;
    ALTER TABLE public.legacy_preview RENAME CONSTRAINT preview_organization_id_id_key TO legacy_preview_organization_id_id_key;
    ALTER TABLE public.legacy_preview RENAME CONSTRAINT preview_slug_check TO legacy_preview_slug_check;
    ALTER TABLE public.legacy_preview RENAME CONSTRAINT preview_app_name_check TO legacy_preview_app_name_check;
    ALTER TABLE public.legacy_preview RENAME CONSTRAINT preview_hostname_check TO legacy_preview_hostname_check;
    ALTER TABLE public.legacy_preview RENAME CONSTRAINT preview_desired_state_check TO legacy_preview_desired_state_check;
    ALTER TABLE public.legacy_preview RENAME CONSTRAINT preview_deleted_at_matches_state TO legacy_preview_deleted_at_matches_state;
    ALTER INDEX public.preview_project_slug_live_idx RENAME TO legacy_preview_project_slug_live_idx;
    ALTER INDEX public.preview_expiry_idx RENAME TO legacy_preview_expiry_idx;

    ALTER TABLE public.legacy_deployment RENAME CONSTRAINT deployment_pkey TO legacy_deployment_pkey;
    ALTER TABLE public.legacy_deployment RENAME CONSTRAINT deployment_organization_id_fkey TO legacy_deployment_organization_id_fkey;
    ALTER TABLE public.legacy_deployment RENAME CONSTRAINT deployment_requested_by_fkey TO legacy_deployment_requested_by_fkey;
    ALTER TABLE public.legacy_deployment RENAME CONSTRAINT deployment_organization_id_preview_id_fkey TO legacy_deployment_organization_id_preview_id_fkey;
    ALTER TABLE public.legacy_deployment RENAME CONSTRAINT deployment_organization_id_artifact_id_fkey TO legacy_deployment_organization_id_artifact_id_fkey;
    ALTER TABLE public.legacy_deployment RENAME CONSTRAINT deployment_organization_id_id_key TO legacy_deployment_organization_id_id_key;
    ALTER TABLE public.legacy_deployment RENAME CONSTRAINT deployment_organization_id_preview_id_id_key TO legacy_deployment_organization_id_preview_id_id_key;
    ALTER TABLE public.legacy_deployment RENAME CONSTRAINT deployment_status_check TO legacy_deployment_status_check;
    ALTER TABLE public.legacy_deployment RENAME CONSTRAINT deployment_attempt_check TO legacy_deployment_attempt_check;
    ALTER TABLE public.legacy_deployment RENAME CONSTRAINT deployment_step_done_check TO legacy_deployment_step_done_check;
    ALTER TABLE public.legacy_deployment RENAME CONSTRAINT deployment_step_pending_check TO legacy_deployment_step_pending_check;
    ALTER INDEX public.deployment_one_unfinished_per_preview RENAME TO legacy_deployment_one_unfinished_per_preview;
    ALTER INDEX public.deployment_preview_idx RENAME TO legacy_deployment_preview_idx;
    ALTER INDEX public.deployment_claim_idx RENAME TO legacy_deployment_claim_idx;

    ALTER TABLE public.legacy_deployment_event RENAME CONSTRAINT deployment_event_pkey TO legacy_deployment_event_pkey;
    ALTER TABLE public.legacy_deployment_event RENAME CONSTRAINT deployment_event_organization_id_fkey TO legacy_deployment_event_organization_id_fkey;
    ALTER TABLE public.legacy_deployment_event RENAME CONSTRAINT deployment_event_organization_id_deployment_id_fkey TO legacy_deployment_event_organization_id_deployment_id_fkey;
    ALTER TABLE public.legacy_deployment_event RENAME CONSTRAINT deployment_event_deployment_id_seq_key TO legacy_deployment_event_deployment_id_seq_key;
    ALTER TABLE public.legacy_deployment_event RENAME CONSTRAINT deployment_event_seq_check TO legacy_deployment_event_seq_check;
    ALTER TABLE public.legacy_deployment_event RENAME CONSTRAINT deployment_event_level_check TO legacy_deployment_event_level_check;
    ALTER TABLE public.legacy_deployment_event RENAME CONSTRAINT deployment_event_message_check TO legacy_deployment_event_message_check;
    ALTER SEQUENCE public.deployment_event_id_seq RENAME TO legacy_deployment_event_id_seq;

    ALTER TABLE public.legacy_deletion_operation RENAME CONSTRAINT deletion_operation_pkey TO legacy_deletion_operation_pkey;
    ALTER TABLE public.legacy_deletion_operation RENAME CONSTRAINT deletion_operation_organization_id_fkey TO legacy_deletion_operation_organization_id_fkey;
    ALTER TABLE public.legacy_deletion_operation RENAME CONSTRAINT deletion_operation_requested_by_fkey TO legacy_deletion_operation_requested_by_fkey;
    ALTER TABLE public.legacy_deletion_operation RENAME CONSTRAINT deletion_operation_organization_id_preview_id_fkey TO legacy_deletion_operation_organization_id_preview_id_fkey;
    ALTER TABLE public.legacy_deletion_operation RENAME CONSTRAINT deletion_operation_organization_id_id_key TO legacy_deletion_operation_organization_id_id_key;
    ALTER TABLE public.legacy_deletion_operation RENAME CONSTRAINT deletion_operation_reason_check TO legacy_deletion_operation_reason_check;
    ALTER TABLE public.legacy_deletion_operation RENAME CONSTRAINT deletion_operation_status_check TO legacy_deletion_operation_status_check;
    ALTER TABLE public.legacy_deletion_operation RENAME CONSTRAINT deletion_operation_attempt_check TO legacy_deletion_operation_attempt_check;
    ALTER TABLE public.legacy_deletion_operation RENAME CONSTRAINT deletion_operation_fence_check TO legacy_deletion_operation_fence_check;
    ALTER TABLE public.legacy_deletion_operation RENAME CONSTRAINT deletion_operation_step_done_check TO legacy_deletion_operation_step_done_check;
    ALTER TABLE public.legacy_deletion_operation RENAME CONSTRAINT deletion_operation_step_pending_check TO legacy_deletion_operation_step_pending_check;
    ALTER INDEX public.deletion_one_unfinished_per_preview RENAME TO legacy_deletion_one_unfinished_per_preview;
    ALTER INDEX public.deletion_claim_idx RENAME TO legacy_deletion_claim_idx;

    SELECT count(*) INTO affected_keys FROM public.api_key
    WHERE EXISTS (SELECT FROM unnest(scopes) AS scope(value) WHERE left(scope.value, 8) = 'preview:');

    WITH revoked AS (
        UPDATE public.api_key SET revoked_at = transaction_timestamp()
        WHERE revoked_at IS NULL
          AND EXISTS (SELECT FROM unnest(scopes) AS scope(value) WHERE left(scope.value, 8) = 'preview:')
        RETURNING id
    )
    SELECT count(*) INTO newly_revoked_keys FROM revoked;

    INSERT INTO public.audit_event (actor, action, target_type, target_id, detail)
    VALUES (
        'operator-cli', 'schema.immutable.preview-keys-revoked',
        'instance', 'immutable-deployment-model',
        json_build_object('affected', affected_keys, 'newlyRevoked', newly_revoked_keys)::text
    );
END
$retirement$;
