import net from "node:net";

// One raw HTTP/1.1 exchange over a socket, so tests control every byte (duplicate headers,
// absolute-form targets) that fetch would normalise away.
export function raw(
    port: number,
    request: string,
): Promise<{ status: number; head: string; body: string }> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1");
        let data = "";
        const timer = setTimeout(() => socket.destroy(new Error("timeout")), 5000);
        socket.setEncoding("utf8");
        socket.on("connect", () => socket.write(request));
        socket.on("data", (chunk) => (data += chunk));
        socket.on("error", reject);
        socket.on("close", () => {
            clearTimeout(timer);
            const [head = "", ...rest] = data.split("\r\n\r\n");
            const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0);
            resolve({ status, head, body: rest.join("\r\n\r\n") });
        });
    });
}

export const get = (port: number, host: string, extra = "", target = "/") =>
    raw(port, `GET ${target} HTTP/1.1\r\nHost: ${host}\r\n${extra}Connection: close\r\n\r\n`);

export async function freePort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
}

export function refused(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect(port, "127.0.0.1");
        socket.on("connect", () => {
            socket.destroy();
            resolve(false);
        });
        socket.on("error", () => resolve(true));
    });
}
