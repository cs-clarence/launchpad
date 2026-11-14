import nodemailer from "nodemailer";
import type { AuthConfig } from "./config";

export interface MailMessage {
    to: string;
    subject: string;
    text: string;
}

// Delivery failures throw; callers decide whether the failure is visible.
export interface Mailer {
    send(message: MailMessage): Promise<void>;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

// SMTP URLs are `smtps://` (implicit TLS) or `smtp://` (STARTTLS required). A
// plain, unencrypted connection is only allowed to a loopback host, so mail
// content and credentials never cross a network in the clear.
export function createSmtpMailer(smtp: { url: string; from: string }): Mailer {
    const url = new URL(smtp.url);
    const secure = url.protocol === "smtps:";
    // Options come from the parsed URL, never passed through as a URL, so nothing
    // in it can switch TLS requirements off or turn on debug logging.
    const transport = nodemailer.createTransport({
        host: url.hostname,
        port: url.port ? Number(url.port) : secure ? 465 : 587,
        secure,
        requireTLS: !secure && !LOOPBACK.has(url.hostname),
        auth: url.username
            ? { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) }
            : undefined,
    });
    return {
        async send(message) {
            await transport.sendMail({ from: smtp.from, ...message });
        },
    };
}

export function createMailer(config: AuthConfig): Mailer | null {
    return config.smtp ? createSmtpMailer(config.smtp) : null;
}
