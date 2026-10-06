// Error reporting (Sentry), when SENTRY_DSN is set; without it this file does
// nothing and Sentry is not even loaded.
//
// It runs before the server's own code: `node --import ./server/instrument.ts
// server/index.ts` (npm start and npm run dev do this). Sentry has to start
// before Express is loaded to see the errors that reach Express's error
// handling; started later, it would report nothing from the routes.
//
// What goes with an error report is kept to the minimum: the people using Rivo
// trust it with their messages and passwords, and a report is read by whoever
// has access to the Sentry project. So: no cookies (the session), no request
// or response bodies (passwords, message text), no query strings (searches),
// no local variables, and only a few harmless headers.
import "./env.ts";
import { config } from "./config.ts";
import { log } from "./utils/logger.ts";

if (config.sentryDsn) {
	const Sentry = await import("@sentry/node");
	try {
		Sentry.init({
			dsn: config.sentryDsn,
			environment: config.isProd ? "production" : process.env.NODE_ENV || "development",
			release: config.version,
			// errors only (no performance tracing)
			dataCollection: {
				userInfo: false,
				cookies: false,
				httpHeaders: {
					request: { allow: ["user-agent", "content-type", "content-length", "accept", "origin", "host"] },
					response: { allow: ["content-type", "content-length"] },
				},
				httpBodies: [],
				urlQueryParams: false,
				databaseQueryData: false,
				queues: false,
				genAI: { inputs: false, outputs: false },
				stackFrameVariables: false,
			},
		});
	} catch (e) {
		log.warn("Sentry could not be started (errors are not reported):", e);
	}
}
