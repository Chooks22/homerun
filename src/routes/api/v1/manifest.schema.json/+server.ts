import { manifestJsonSchema } from "#lib/server/manifest.js";

export const GET = () => Response.json(manifestJsonSchema());
