import { type Kysely, sql } from "kysely";

// Forward-only, frozen SQL: Kysely owns the transaction. Before running this, stop
// all old processes, settle dispatched Dokku work, back up, and inventory/remove
// old apps with the pre-018 binary. Dropped identities are intentionally not kept.
export async function up(db: Kysely<any>): Promise<void> {
    await sql`set local lock_timeout = '5s'`.execute(db);
    await sql`drop table deployment_event, deletion_operation, deployment, preview, worker_heartbeat`.execute(
        db,
    );
    await sql`delete from idempotency_key`.execute(db);
    await sql`delete from instance_state where key = 'lifecycle.enabled_at'`.execute(db);
    await sql`
        with revoked as (
            update api_key set revoked_at = now()
            where revoked_at is null
              and exists (select 1 from unnest(scopes) as scope where scope like 'preview:%')
            returning id
        )
        insert into audit_event (actor, action, target_type, target_id, organization_id, detail)
        select 'system', 'deployment.cutover', 'instance', 'self', null,
            'revoked_keys=' || count(*)::text from revoked
    `.execute(db);
    await sql`

    CREATE FUNCTION public.deployment_hostname_valid(value text) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog AS $function$
        SELECT length(value) <= 253 AND value = lower(value)
            AND cardinality(string_to_array(value, '.')) >= 2
            AND NOT EXISTS (
                SELECT FROM unnest(string_to_array(value, '.')) AS label(value)
                WHERE label.value !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
            )
    $function$;

    CREATE TABLE public.app (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id text NOT NULL,
        project_id uuid NOT NULL,
        slug text NOT NULL CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
        state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'shutting-down', 'deleted')),
        created_by text NOT NULL REFERENCES public."user"(id) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz,
        UNIQUE (organization_id, id),
        UNIQUE (organization_id, project_id, id),
        FOREIGN KEY (organization_id, project_id)
            REFERENCES public.project(organization_id, id) ON DELETE RESTRICT,
        CHECK ((state = 'deleted') = (deleted_at IS NOT NULL))
    );
    CREATE UNIQUE INDEX app_project_slug_live_idx ON public.app(project_id, slug)
        WHERE state <> 'deleted';
    CREATE INDEX app_org_created_idx ON public.app(organization_id, created_at, id);

    CREATE TABLE public.deployment (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id text NOT NULL,
        app_id uuid NOT NULL,
        artifact_id uuid NOT NULL,
        spa boolean NOT NULL DEFAULT false,
        app_name text NOT NULL UNIQUE CHECK (app_name ~ '^lp-[a-z0-9]{10}$'),
        hostname text NOT NULL UNIQUE CHECK (public.deployment_hostname_valid(hostname)),
        status text NOT NULL DEFAULT 'queued' CHECK (status IN (
            'queued', 'preparing', 'building', 'deploying', 'verifying',
            'succeeded', 'failed', 'cancelled', 'reconciliation-needed'
        )),
        attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
        fence bigint NOT NULL DEFAULT 0 CHECK (fence >= 0),
        lease_owner text,
        lease_expires_at timestamptz,
        step_done text CHECK (step_done IN ('app', 'build', 'configure', 'load', 'verify')),
        step_pending text CHECK (step_pending IN ('app', 'build', 'configure', 'load', 'verify')),
        image_tag text UNIQUE,
        image_id text CHECK (image_id ~ '^sha256:[0-9a-f]{64}$'),
        failure_code text,
        failure_message text CHECK (length(failure_message) <= 500),
        requested_by text NOT NULL REFERENCES public."user"(id) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz,
        preview_expires_at timestamptz NOT NULL,
        last_unpinned_at timestamptz,
        desired_state text NOT NULL DEFAULT 'active' CHECK (desired_state IN ('active', 'deleting', 'deleted')),
        deleted_at timestamptz,
        UNIQUE (organization_id, id),
        UNIQUE (organization_id, app_id, id),
        FOREIGN KEY (organization_id, app_id)
            REFERENCES public.app(organization_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (organization_id, artifact_id)
            REFERENCES public.artifact(organization_id, id) ON DELETE RESTRICT,
        CHECK ((desired_state = 'deleted') = (deleted_at IS NOT NULL)),
        CHECK (status <> 'succeeded' OR
            (image_tag IS NOT NULL AND image_id IS NOT NULL AND finished_at IS NOT NULL))
    );
    CREATE UNIQUE INDEX deployment_one_unfinished_per_app
        ON public.deployment(app_id)
        WHERE status IN ('queued', 'preparing', 'building', 'deploying', 'verifying', 'reconciliation-needed');
    CREATE INDEX deployment_app_created_idx
        ON public.deployment(app_id, created_at DESC, id);
    CREATE INDEX deployment_artifact_idx
        ON public.deployment(organization_id, artifact_id);
    CREATE INDEX deployment_claim_idx ON public.deployment(created_at, id)
        WHERE status IN ('queued', 'preparing', 'building', 'deploying', 'verifying');
    CREATE INDEX deployment_expiry_idx ON public.deployment(preview_expires_at)
        WHERE desired_state = 'active';

    CREATE TABLE public.app_deployment_event (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        organization_id text NOT NULL,
        deployment_id uuid NOT NULL,
        seq integer NOT NULL CHECK (seq >= 1),
        phase text NOT NULL,
        level text NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warn', 'error')),
        message text NOT NULL CHECK (length(message) <= 500),
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (deployment_id, seq),
        FOREIGN KEY (organization_id, deployment_id)
            REFERENCES public.deployment(organization_id, id) ON DELETE RESTRICT
    );

    CREATE TABLE public.app_alias (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id text NOT NULL,
        app_id uuid NOT NULL,
        slug text NOT NULL CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
        hostname text NOT NULL UNIQUE CHECK (public.deployment_hostname_valid(hostname)),
        target_deployment_id uuid,
        state text NOT NULL DEFAULT 'unbound' CHECK (state IN (
            'unbound', 'bound', 'binding', 'binding-uncertain',
            'withdrawing', 'withdrawal-uncertain', 'withdrawn'
        )),
        reserved_generation bigint NOT NULL DEFAULT 0 CHECK (reserved_generation >= 0),
        committed_generation bigint NOT NULL DEFAULT 0 CHECK (committed_generation >= 0),
        created_by text NOT NULL REFERENCES public."user"(id) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (organization_id, app_id, id),
        FOREIGN KEY (organization_id, app_id)
            REFERENCES public.app(organization_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (organization_id, app_id, target_deployment_id)
            REFERENCES public.deployment(organization_id, app_id, id) ON DELETE RESTRICT,
        CHECK (committed_generation <= reserved_generation),
        CHECK (state <> 'unbound' OR (target_deployment_id IS NULL AND committed_generation = 0)),
        CHECK (state <> 'bound' OR (target_deployment_id IS NOT NULL AND committed_generation > 0)),
        CHECK (state <> 'withdrawn' OR (target_deployment_id IS NULL AND committed_generation > 0))
    );
    CREATE UNIQUE INDEX app_alias_slug_live_idx ON public.app_alias(app_id, slug)
        WHERE state <> 'withdrawn';

    CREATE TABLE public.promotion_operation (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id text NOT NULL,
        app_id uuid NOT NULL,
        alias_id uuid NOT NULL,
        action text NOT NULL CHECK (action IN ('bind', 'withdraw')),
        idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
        previous_target_deployment_id uuid,
        desired_target_deployment_id uuid,
        expected_generation bigint NOT NULL CHECK (expected_generation >= 0),
        generation bigint NOT NULL CHECK (generation > expected_generation),
        status text NOT NULL DEFAULT 'queued' CHECK (status IN (
            'queued', 'applying', 'verifying', 'succeeded', 'failed', 'reconciliation-needed', 'superseded'
        )),
        attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
        fence bigint NOT NULL DEFAULT 0 CHECK (fence >= 0),
        lease_owner text,
        lease_expires_at timestamptz,
        step_pending text CHECK (step_pending IN ('dispatch', 'verify')),
        step_done text CHECK (step_done IN ('dispatch', 'verify')),
        supersedes_operation_id uuid,
        superseded_by_operation_id uuid,
        failure_code text,
        failure_message text CHECK (length(failure_message) <= 500),
        observed_epoch uuid,
        observed_generation bigint CHECK (observed_generation >= 0),
        observed_operation_id uuid,
        observed_target_deployment_id uuid,
        requested_by text NOT NULL REFERENCES public."user"(id) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz,
        UNIQUE (alias_id, generation),
        UNIQUE (alias_id, id),
        FOREIGN KEY (organization_id, app_id, alias_id)
            REFERENCES public.app_alias(organization_id, app_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (organization_id, app_id, previous_target_deployment_id)
            REFERENCES public.deployment(organization_id, app_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (organization_id, app_id, desired_target_deployment_id)
            REFERENCES public.deployment(organization_id, app_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (alias_id, supersedes_operation_id)
            REFERENCES public.promotion_operation(alias_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
        FOREIGN KEY (alias_id, superseded_by_operation_id)
            REFERENCES public.promotion_operation(alias_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
        CHECK ((action = 'bind') = (desired_target_deployment_id IS NOT NULL)),
        CHECK (status <> 'superseded' OR superseded_by_operation_id IS NOT NULL),
        CHECK (status NOT IN ('succeeded', 'failed') OR superseded_by_operation_id IS NULL),
        CHECK (supersedes_operation_id <> id),
        CHECK (superseded_by_operation_id <> id)
    );
    CREATE UNIQUE INDEX promotion_operation_one_unfinished_per_alias
        ON public.promotion_operation(alias_id)
        WHERE status IN ('queued', 'applying', 'verifying', 'reconciliation-needed')
            AND superseded_by_operation_id IS NULL;
    CREATE INDEX promotion_operation_claim_idx ON public.promotion_operation(created_at, id)
        WHERE status IN ('queued', 'applying', 'verifying') AND superseded_by_operation_id IS NULL;
    CREATE INDEX promotion_operation_previous_target_idx
        ON public.promotion_operation(organization_id, app_id, previous_target_deployment_id);
    CREATE INDEX promotion_operation_desired_target_idx
        ON public.promotion_operation(organization_id, app_id, desired_target_deployment_id);

    CREATE TABLE public.deployment_deletion_operation (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id text NOT NULL,
        app_id uuid NOT NULL,
        deployment_id uuid NOT NULL,
        reason text NOT NULL CHECK (reason IN ('manual', 'expired', 'shutdown')),
        status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'reconciliation-needed')),
        attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
        fence bigint NOT NULL DEFAULT 0 CHECK (fence >= 0),
        lease_owner text,
        lease_expires_at timestamptz,
        step_pending text CHECK (step_pending IN ('destroy', 'images')),
        step_done text CHECK (step_done IN ('destroy', 'images')),
        requested_by text REFERENCES public."user"(id) ON DELETE RESTRICT,
        failure_code text,
        failure_message text CHECK (length(failure_message) <= 500),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz,
        CHECK (reason <> 'manual' OR requested_by IS NOT NULL),
        FOREIGN KEY (organization_id, app_id, deployment_id)
            REFERENCES public.deployment(organization_id, app_id, id) ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX deployment_deletion_one_unfinished
        ON public.deployment_deletion_operation(deployment_id)
        WHERE status IN ('queued', 'running', 'reconciliation-needed');
    CREATE INDEX deployment_deletion_claim_idx ON public.deployment_deletion_operation(created_at, id)
        WHERE status IN ('queued', 'running');

    CREATE TABLE public.hostname_reservation (
        hostname text PRIMARY KEY CHECK (public.deployment_hostname_valid(hostname)),
        owner_kind text NOT NULL CHECK (owner_kind IN ('deployment', 'alias')),
        owner_id uuid NOT NULL,
        organization_id text NOT NULL REFERENCES public.organization(id) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT now(),
        released_at timestamptz,
        UNIQUE (owner_kind, owner_id),
        CHECK (released_at >= created_at)
    );
    CREATE TABLE public.dokku_name_reservation (
        app_name text PRIMARY KEY CHECK (app_name ~ '^lp-[a-z0-9]{10}$'),
        owner_kind text NOT NULL CHECK (owner_kind = 'deployment'),
        owner_id uuid NOT NULL,
        organization_id text NOT NULL REFERENCES public.organization(id) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT now(),
        released_at timestamptz,
        UNIQUE (owner_kind, owner_id),
        CHECK (released_at >= created_at)
    );

    -- Ordinary invoker functions: these enforce invariants, not privileges.
    -- Separate application/owner roles are a production deployment gate.
    CREATE FUNCTION public.deployment_check_reservations(kind text, resource_id uuid)
    RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
    DECLARE
        expected_host text;
        expected_app text;
        expected_org text;
        expected_retired boolean;
    BEGIN
        CASE kind
            WHEN 'deployment' THEN
                SELECT hostname, app_name, organization_id, desired_state = 'deleted'
                INTO expected_host, expected_app, expected_org, expected_retired
                FROM public.deployment WHERE id = resource_id;
            WHEN 'alias' THEN
                SELECT hostname, organization_id, state = 'withdrawn'
                INTO expected_host, expected_org, expected_retired
                FROM public.app_alias WHERE id = resource_id;
            ELSE
                RAISE EXCEPTION 'unknown reservation owner kind' USING ERRCODE = '23514';
        END CASE;
        IF expected_host IS NULL OR NOT EXISTS (
            SELECT FROM public.hostname_reservation
            WHERE hostname = expected_host AND owner_kind = kind
              AND owner_id = resource_id AND organization_id = expected_org
        ) THEN
            RAISE EXCEPTION 'owner and hostname reservation must match' USING ERRCODE = '23514';
        END IF;
        IF kind <> 'alias' AND NOT EXISTS (
            SELECT FROM public.dokku_name_reservation
            WHERE app_name = expected_app AND owner_kind = kind
              AND owner_id = resource_id AND organization_id = expected_org
        ) THEN
            RAISE EXCEPTION 'owner and Dokku name reservation must match' USING ERRCODE = '23514';
        END IF;
        IF NOT expected_retired AND (
            EXISTS (SELECT FROM public.hostname_reservation
                WHERE hostname = expected_host AND released_at IS NOT NULL)
            OR EXISTS (SELECT FROM public.dokku_name_reservation
                WHERE app_name = expected_app AND released_at IS NOT NULL)
        ) THEN
            RAISE EXCEPTION 'reservation release requires a retired owner' USING ERRCODE = '23514';
        END IF;
    END
    $function$;

    CREATE FUNCTION public.deployment_validate_reservation() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
    BEGIN
        PERFORM public.deployment_check_reservations(NEW.owner_kind, NEW.owner_id);
        RETURN NULL;
    END
    $function$;
    CREATE FUNCTION public.deployment_validate_owner() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
    BEGIN
        CASE TG_TABLE_NAME
            WHEN 'deployment' THEN
                PERFORM public.deployment_check_reservations('deployment', NEW.id);
            WHEN 'app_alias' THEN
                PERFORM public.deployment_check_reservations('alias', NEW.id);
            ELSE
                RAISE EXCEPTION 'unexpected reservation owner table' USING ERRCODE = '23514';
        END CASE;
        RETURN NULL;
    END
    $function$;

    -- An audit release never frees a registry key. Freeze identity immediately;
    -- deferred triggers below validate the reciprocal owner at transaction end.
    CREATE FUNCTION public.deployment_protect_reservation() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
    BEGIN
        IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'reservation history is permanent' USING ERRCODE = '23514';
        END IF;
        IF (to_jsonb(NEW) - 'released_at') IS DISTINCT FROM (to_jsonb(OLD) - 'released_at')
           OR (OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at) THEN
            RAISE EXCEPTION 'reservation identity and release history are immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END
    $function$;

    CREATE FUNCTION public.deployment_protect_owner() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
    BEGIN
        IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'resource identity history is permanent' USING ERRCODE = '23514';
        END IF;
        IF ROW(NEW.id, NEW.organization_id, NEW.app_id, NEW.hostname)
            IS DISTINCT FROM ROW(OLD.id, OLD.organization_id, OLD.app_id, OLD.hostname) THEN
            RAISE EXCEPTION 'resource identity is immutable' USING ERRCODE = '23514';
        END IF;
        IF TG_TABLE_NAME = 'deployment' THEN
            IF ROW(NEW.artifact_id, NEW.spa, NEW.app_name, NEW.requested_by, NEW.created_at)
                IS DISTINCT FROM ROW(OLD.artifact_id, OLD.spa, OLD.app_name, OLD.requested_by, OLD.created_at)
               OR NEW.fence < OLD.fence THEN
                RAISE EXCEPTION 'deployment identity and fence are immutable or monotonic' USING ERRCODE = '23514';
            END IF;
            IF OLD.status IN ('succeeded', 'failed', 'cancelled')
               AND ROW(NEW.status, NEW.image_tag, NEW.image_id, NEW.finished_at)
                   IS DISTINCT FROM ROW(OLD.status, OLD.image_tag, OLD.image_id, OLD.finished_at) THEN
                RAISE EXCEPTION 'completed deployment cannot be redeployed or rewritten' USING ERRCODE = '23514';
            END IF;
            IF OLD.desired_state = 'deleted' AND NEW.desired_state <> 'deleted' THEN
                RAISE EXCEPTION 'deleted deployment cannot be reactivated' USING ERRCODE = '23514';
            END IF;
            IF OLD.desired_state = 'deleting' AND NEW.desired_state = 'active' THEN
                RAISE EXCEPTION 'deployment deletion cannot be cancelled' USING ERRCODE = '23514';
            END IF;
        ELSE
            IF ROW(NEW.slug, NEW.created_by, NEW.created_at)
                IS DISTINCT FROM ROW(OLD.slug, OLD.created_by, OLD.created_at)
               OR NEW.reserved_generation < OLD.reserved_generation
               OR NEW.committed_generation < OLD.committed_generation
               OR (NEW.target_deployment_id IS DISTINCT FROM OLD.target_deployment_id
                   AND NEW.committed_generation <= OLD.committed_generation)
               OR (OLD.state = 'withdrawn' AND NEW.state <> 'withdrawn') THEN
                RAISE EXCEPTION 'alias identity, generations and withdrawal are fenced' USING ERRCODE = '23514';
            END IF;
        END IF;
        RETURN NEW;
    END
    $function$;

    CREATE FUNCTION public.deployment_protect_app() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
    BEGIN
        IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'app identity history is permanent' USING ERRCODE = '23514';
        END IF;
        IF ROW(NEW.id, NEW.organization_id, NEW.project_id, NEW.slug, NEW.created_by, NEW.created_at)
            IS DISTINCT FROM ROW(OLD.id, OLD.organization_id, OLD.project_id, OLD.slug, OLD.created_by, OLD.created_at)
           OR (OLD.state = 'deleted' AND NEW.state <> 'deleted') THEN
            RAISE EXCEPTION 'app identity and retirement are immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END
    $function$;

    CREATE FUNCTION public.deployment_protect_operation() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
    BEGIN
        IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'operation history is permanent' USING ERRCODE = '23514';
        END IF;
        IF ROW(NEW.id, NEW.organization_id, NEW.app_id, NEW.requested_by, NEW.created_at)
            IS DISTINCT FROM ROW(OLD.id, OLD.organization_id, OLD.app_id, OLD.requested_by, OLD.created_at)
           OR NEW.fence < OLD.fence THEN
            RAISE EXCEPTION 'operation identity and fence are immutable or monotonic' USING ERRCODE = '23514';
        END IF;
        IF TG_TABLE_NAME = 'promotion_operation' THEN
            IF ROW(NEW.alias_id, NEW.action, NEW.idempotency_key, NEW.previous_target_deployment_id,
                   NEW.desired_target_deployment_id, NEW.expected_generation,
                   NEW.generation, NEW.supersedes_operation_id)
               IS DISTINCT FROM
                ROW(OLD.alias_id, OLD.action, OLD.idempotency_key, OLD.previous_target_deployment_id,
                   OLD.desired_target_deployment_id, OLD.expected_generation,
                   OLD.generation, OLD.supersedes_operation_id)
               OR (OLD.superseded_by_operation_id IS NOT NULL
                    AND NEW.superseded_by_operation_id IS DISTINCT FROM OLD.superseded_by_operation_id)
               OR (OLD.status IN ('succeeded', 'failed')
                   AND NEW.superseded_by_operation_id IS DISTINCT FROM OLD.superseded_by_operation_id)
               OR (OLD.status IN ('succeeded', 'failed', 'superseded') AND NEW.status <> OLD.status) THEN
                RAISE EXCEPTION 'promotion intent and settled outcome are immutable' USING ERRCODE = '23514';
            END IF;
        ELSE
            IF ROW(NEW.deployment_id, NEW.reason) IS DISTINCT FROM ROW(OLD.deployment_id, OLD.reason)
               OR (OLD.status = 'succeeded' AND NEW.status <> 'succeeded') THEN
                RAISE EXCEPTION 'deletion intent and settled outcome are immutable' USING ERRCODE = '23514';
            END IF;
        END IF;
        RETURN NEW;
    END
    $function$;

    CREATE FUNCTION public.deployment_protect_event() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
    BEGIN
        RAISE EXCEPTION 'deployment events are append only' USING ERRCODE = '23514';
    END
    $function$;

    CREATE FUNCTION public.deployment_protect_truncate() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
    BEGIN
        RAISE EXCEPTION 'resource history cannot be truncated' USING ERRCODE = '23514';
    END
    $function$;

    REVOKE ALL ON FUNCTION public.deployment_check_reservations(text, uuid) FROM PUBLIC;
    REVOKE ALL ON FUNCTION public.deployment_validate_reservation() FROM PUBLIC;
    REVOKE ALL ON FUNCTION public.deployment_validate_owner() FROM PUBLIC;
    REVOKE ALL ON FUNCTION public.deployment_protect_reservation() FROM PUBLIC;
    REVOKE ALL ON FUNCTION public.deployment_protect_owner() FROM PUBLIC;
    REVOKE ALL ON FUNCTION public.deployment_protect_app() FROM PUBLIC;
    REVOKE ALL ON FUNCTION public.deployment_protect_operation() FROM PUBLIC;
    REVOKE ALL ON FUNCTION public.deployment_protect_event() FROM PUBLIC;
    REVOKE ALL ON FUNCTION public.deployment_protect_truncate() FROM PUBLIC;

    CREATE TRIGGER hostname_reservation_permanent
        BEFORE UPDATE OR DELETE ON public.hostname_reservation
        FOR EACH ROW EXECUTE FUNCTION public.deployment_protect_reservation();
    CREATE TRIGGER dokku_name_reservation_permanent
        BEFORE UPDATE OR DELETE ON public.dokku_name_reservation
        FOR EACH ROW EXECUTE FUNCTION public.deployment_protect_reservation();
    CREATE TRIGGER deployment_identity
        BEFORE UPDATE OR DELETE ON public.deployment
        FOR EACH ROW EXECUTE FUNCTION public.deployment_protect_owner();
    CREATE TRIGGER app_alias_identity
        BEFORE UPDATE OR DELETE ON public.app_alias
        FOR EACH ROW EXECUTE FUNCTION public.deployment_protect_owner();
    CREATE TRIGGER app_identity
        BEFORE UPDATE OR DELETE ON public.app
        FOR EACH ROW EXECUTE FUNCTION public.deployment_protect_app();
    CREATE TRIGGER promotion_intent
        BEFORE UPDATE OR DELETE ON public.promotion_operation
        FOR EACH ROW EXECUTE FUNCTION public.deployment_protect_operation();
    CREATE TRIGGER deployment_deletion_intent
        BEFORE UPDATE OR DELETE ON public.deployment_deletion_operation
        FOR EACH ROW EXECUTE FUNCTION public.deployment_protect_operation();
    CREATE TRIGGER app_deployment_event_append_only
        BEFORE UPDATE OR DELETE ON public.app_deployment_event
        FOR EACH ROW EXECUTE FUNCTION public.deployment_protect_event();

    CREATE TRIGGER hostname_reservation_no_truncate BEFORE TRUNCATE ON public.hostname_reservation
        FOR EACH STATEMENT EXECUTE FUNCTION public.deployment_protect_truncate();
    CREATE TRIGGER dokku_name_reservation_no_truncate BEFORE TRUNCATE ON public.dokku_name_reservation
        FOR EACH STATEMENT EXECUTE FUNCTION public.deployment_protect_truncate();
    CREATE TRIGGER app_no_truncate BEFORE TRUNCATE ON public.app
        FOR EACH STATEMENT EXECUTE FUNCTION public.deployment_protect_truncate();
    CREATE TRIGGER deployment_no_truncate BEFORE TRUNCATE ON public.deployment
        FOR EACH STATEMENT EXECUTE FUNCTION public.deployment_protect_truncate();
    CREATE TRIGGER app_alias_no_truncate BEFORE TRUNCATE ON public.app_alias
        FOR EACH STATEMENT EXECUTE FUNCTION public.deployment_protect_truncate();
    CREATE TRIGGER promotion_operation_no_truncate BEFORE TRUNCATE ON public.promotion_operation
        FOR EACH STATEMENT EXECUTE FUNCTION public.deployment_protect_truncate();
    CREATE TRIGGER deployment_deletion_no_truncate BEFORE TRUNCATE ON public.deployment_deletion_operation
        FOR EACH STATEMENT EXECUTE FUNCTION public.deployment_protect_truncate();
    CREATE TRIGGER app_deployment_event_no_truncate BEFORE TRUNCATE ON public.app_deployment_event
        FOR EACH STATEMENT EXECUTE FUNCTION public.deployment_protect_truncate();

    CREATE CONSTRAINT TRIGGER hostname_reservation_owner
        AFTER INSERT OR UPDATE ON public.hostname_reservation
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        EXECUTE FUNCTION public.deployment_validate_reservation();
    CREATE CONSTRAINT TRIGGER dokku_name_reservation_owner
        AFTER INSERT OR UPDATE ON public.dokku_name_reservation
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        EXECUTE FUNCTION public.deployment_validate_reservation();
    CREATE CONSTRAINT TRIGGER deployment_reservations
        AFTER INSERT OR UPDATE ON public.deployment
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        EXECUTE FUNCTION public.deployment_validate_owner();
    CREATE CONSTRAINT TRIGGER app_alias_reservations
        AFTER INSERT OR UPDATE ON public.app_alias
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        EXECUTE FUNCTION public.deployment_validate_owner();
    `.execute(db);
    // An older restored dump may already have been marked blocked by this binary.
    // Initialize a fresh instance, never overwrite that recovery decision.
    await sql`insert into instance_state (key, value) values ('deployment_recovery', 'ready')
        on conflict (key) do nothing`.execute(db);
}
