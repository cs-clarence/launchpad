export interface DokkuConnection {
    host: string;
    port: number;
    username: string;
    privateKeyPath: string;
    // A file of host keys provisioned out of band (read from the Dokku host itself).
    // It is never extended at run time: the client never scans for or learns a key.
    knownHostsPath: string;
}
