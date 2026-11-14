// A minimal in-process SMTP server that records messages, for integration tests.
// It speaks just enough of RFC 5321 for nodemailer: no TLS, no authentication.
export interface CapturedMail {
    from: string;
    to: string[];
    data: string;
}

export interface FakeSmtp {
    url: string;
    messages: CapturedMail[];
    stop(): void;
}

export function startFakeSmtp(): FakeSmtp {
    const messages: CapturedMail[] = [];
    interface State {
        buffer: string;
        inData: boolean;
        from: string;
        to: string[];
        data: string;
    }
    const server = Bun.listen<State>({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
            open(socket) {
                socket.data = { buffer: "", inData: false, from: "", to: [], data: "" };
                socket.write("220 fake ESMTP\r\n");
            },
            data(socket, chunk) {
                const state = socket.data;
                state.buffer += chunk.toString("utf8");
                let index: number;
                while ((index = state.buffer.indexOf("\r\n")) >= 0) {
                    const line = state.buffer.slice(0, index);
                    state.buffer = state.buffer.slice(index + 2);
                    if (state.inData) {
                        if (line === ".") {
                            state.inData = false;
                            messages.push({ from: state.from, to: state.to, data: state.data });
                            state.data = "";
                            state.to = [];
                            socket.write("250 queued\r\n");
                        } else {
                            state.data += `${line.startsWith("..") ? line.slice(1) : line}\r\n`;
                        }
                        continue;
                    }
                    const command = line.toUpperCase();
                    if (command.startsWith("EHLO") || command.startsWith("HELO")) {
                        socket.write("250 fake\r\n");
                    } else if (command.startsWith("MAIL FROM")) {
                        state.from = /<([^>]*)>/.exec(line)?.[1] ?? "";
                        socket.write("250 ok\r\n");
                    } else if (command.startsWith("RCPT TO")) {
                        state.to.push(/<([^>]*)>/.exec(line)?.[1] ?? "");
                        socket.write("250 ok\r\n");
                    } else if (command === "DATA") {
                        state.inData = true;
                        socket.write("354 go\r\n");
                    } else if (command === "QUIT") {
                        socket.write("221 bye\r\n");
                        socket.end();
                    } else {
                        socket.write("250 ok\r\n");
                    }
                }
            },
        },
    });
    return {
        url: `smtp://127.0.0.1:${server.port}`,
        messages,
        stop: () => server.stop(true),
    };
}

// The message body, decoded only when the message declares quoted-printable
// (nodemailer uses it for long lines or non-ASCII text, otherwise 7bit). Decoding
// unconditionally would corrupt text such as `=B8` that merely looks like an escape.
export function mailText(mail: CapturedMail): string {
    const split = mail.data.indexOf("\r\n\r\n");
    const headers = mail.data.slice(0, split);
    const body = mail.data.slice(split + 4);
    if (!/^content-transfer-encoding:\s*quoted-printable\s*$/im.test(headers)) {
        return body;
    }
    return body
        .replace(/=\r\n/g, "")
        .replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}
