// The successful answer of a route, type-checked against the contract
// (shared/api.ts): `reply(res, "GET /api/users/me", me)` does not compile if
// `me` is not what the app expects from that endpoint.
import type { Response } from "express";
import type { Answer, Endpoint } from "../../shared/api.ts";

export function reply<E extends Endpoint>(res: Response, _endpoint: E, body: Answer<E>, status = 200): void {
	res.status(status).json(body);
}
