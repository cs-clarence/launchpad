// Router-local state only. These are not Launchpad application database migrations.
export const SCHEMA_VERSION = 1;
export const APPLICATION_ID = 0x4c504152; // LPAR
export const SCHEMA = `
CREATE TABLE epoch (
    epoch TEXT PRIMARY KEY,
    credential_hash TEXT NOT NULL UNIQUE CHECK(
        length(credential_hash)=64 AND credential_hash NOT GLOB '*[^0-9a-f]*'
    )
) STRICT;
CREATE TABLE metadata (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    instance_id TEXT NOT NULL,
    active_epoch TEXT NOT NULL REFERENCES epoch(epoch)
) STRICT;
CREATE TABLE reservation (
    hostname TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('alias','deployment')),
    owner_id TEXT NOT NULL,
    UNIQUE(kind,owner_id),
    UNIQUE(hostname,kind,owner_id)
) STRICT;
CREATE TABLE deployment (
    deployment_id TEXT PRIMARY KEY,
    hostname TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL DEFAULT 'deployment' CHECK(kind='deployment'),
    FOREIGN KEY(hostname,kind,deployment_id) REFERENCES reservation(hostname,kind,owner_id)
) STRICT;
CREATE TABLE operation (
    operation_id TEXT PRIMARY KEY,
    alias_id TEXT NOT NULL,
    hostname TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'alias' CHECK(kind='alias'),
    generation TEXT NOT NULL CHECK(
        length(generation) BETWEEN 1 AND 19
        AND generation NOT GLOB '*[^0-9]*'
        AND substr(generation,1,1) BETWEEN '1' AND '9'
        AND (length(generation)<19 OR generation<='9223372036854775807')
    ),
    target_deployment_id TEXT REFERENCES deployment(deployment_id),
    FOREIGN KEY(hostname,kind,alias_id) REFERENCES reservation(hostname,kind,owner_id),
    UNIQUE(alias_id,generation),
    UNIQUE(hostname,alias_id,operation_id)
) STRICT;
CREATE TABLE route (
    hostname TEXT PRIMARY KEY,
    alias_id TEXT NOT NULL UNIQUE,
    operation_id TEXT NOT NULL UNIQUE,
    FOREIGN KEY(hostname,alias_id,operation_id) REFERENCES operation(hostname,alias_id,operation_id)
) STRICT;
PRAGMA application_id=${APPLICATION_ID};
PRAGMA user_version=${SCHEMA_VERSION};
`;
