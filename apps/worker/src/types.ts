export interface DeployContext {
    deploymentId: string;
    appName: string;
    hostname: string;
    spa: boolean;
    storageKey: string;
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
