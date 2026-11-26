import { createRouter } from "@tanstack/react-router";
import { ErrorPage } from "./components/service-unavailable";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
    return createRouter({
        routeTree,
        scrollRestoration: true,
        defaultErrorComponent: ({ error }) => <ErrorPage error={error} />,
    });
}

declare module "@tanstack/react-router" {
    interface Register {
        router: ReturnType<typeof getRouter>;
    }
}
