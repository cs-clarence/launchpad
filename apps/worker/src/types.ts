// The worker's own port types. They were defined by the preview services, which were removed;
// the immutable-model worker redefines them in P3, so this file is deliberately small and local.

export interface DeployContext {
    deploymentId: string;
    appName: string;
    hostname: string;
    spa: boolean;
    storageKey: string;
}

// What the worker can do. `dokku` is structurally the @launchpad-kit/dokku client.
export interface DeployPorts {
    dokku: {
        apps: {
            exists(app: string, signal?: AbortSignal): Promise<boolean>;
            create(app: string, signal?: AbortSignal): Promise<void>;
        };
        domains: { set(app: string, host: string, signal?: AbortSignal): Promise<void> };
        ports: { set(app: string, mapping: string, signal?: AbortSignal): Promise<void> };
    };
    // Builds the image for this deployment and returns its tag. Idempotent.
    build(context: DeployContext, signal: AbortSignal): Promise<{ imageTag: string }>;
    // Streams the built image to Dokku. Not idempotent in effect.
    loadImage(context: DeployContext, imageTag: string, signal: AbortSignal): Promise<void>;
    // Reads the app through the proxy; throws when it is not serving the new image.
    verify(context: DeployContext, signal: AbortSignal): Promise<void>;
    // Puts the previously active release back: rebuilds it from its own stored artifact, loads
    // it, and checks that it is the one serving. The immutable model removes this in P3.
    rollback(context: DeployContext, previous: DeployContext, signal: AbortSignal): Promise<void>;
}

export interface DeletionContext {
    previewId: string;
    appName: string;
}

// What the worker can do to destroy one named app and the images it built for it.
export interface LifecyclePorts {
    dokku: {
        apps: {
            exists(app: string, signal?: AbortSignal): Promise<boolean>;
            destroy(app: string, signal?: AbortSignal): Promise<void>;
        };
    };
    // Removes the images the worker built, by exact tag. Removing one that is gone is not an error.
    removeImages(
        context: DeletionContext & { imageTags: string[] },
        signal: AbortSignal,
    ): Promise<void>;
}
