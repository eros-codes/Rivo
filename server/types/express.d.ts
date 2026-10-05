// What Rivo adds to Express's request. Set by requireAuth
// (middleware/auth.ts): only read in routes behind it.
declare global {
	namespace Express {
		interface Request {
			/** the signed-in user */
			userId: number;
			/** the signed-in device's session */
			sessionId: string;
		}
	}
}

export {};
