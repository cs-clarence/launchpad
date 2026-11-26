import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { ErrorPage } from "../components/service-unavailable";
import stylesheet from "../styles.css?url";

export const Route = createRootRoute({
    head: () => ({
        meta: [
            { charSet: "utf-8" },
            { name: "viewport", content: "width=device-width, initial-scale=1" },
            { title: "Launchpad" },
        ],
        links: [{ rel: "stylesheet", href: stylesheet }],
    }),
    shellComponent: RootDocument,
    component: Outlet,
    errorComponent: ({ error }) => <ErrorPage error={error} />,
});

function RootDocument({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en" data-theme="cerberus">
            <head>
                <HeadContent />
            </head>
            <body>
                {children}
                <Scripts />
            </body>
        </html>
    );
}
