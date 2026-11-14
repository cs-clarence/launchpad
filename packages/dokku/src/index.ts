// Configuration boundary only. SSH execution and host-key verification are not
// implemented yet; do not turn this into an arbitrary shell command API.
export interface DokkuConnection {
    host: string;
    port: number;
    username: string;
    privateKeyPath: string;
    knownHostsPath: string;
}
