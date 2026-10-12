import { WorkstationDTO } from "#lib/dto/workstation-dto.js";
import { Logger } from "#lib/logger.js";
import { WorkerRequestError } from "#lib/server/worker-client.js";
import { AgentRequestError } from "#lib/services/agent-client.service.js";
import { WorkstationService } from "#lib/services/workstation.service.js";

const logger = new Logger("Workstation");

export const GET = async ({ params, locals }) => {
	if (!locals.user) {
		return new Response("Unauthorized", { status: 401 });
	}
	const ws = await WorkstationDTO.get(params.workstationId, locals.user.id);
	if (!ws) {
		return new Response("Workstation not found.", { status: 404 });
	}
	try {
		const stream = await WorkstationService.streamLogs(ws);
		return new Response(stream, {
			headers: {
				"Cache-Control": "no-store",
				"Content-Type": "text/plain; charset=utf-8",
			},
		});
	} catch (error) {
		const status =
			error instanceof AgentRequestError || error instanceof WorkerRequestError
				? error.status
				: 502;
		if (status !== 404) {
			logger.warn(`Workstation logs failed: workstation=${ws.id}`, error);
		}
		return new Response(
			status === 404
				? "This workstation has no container yet. Start it from the Overview tab."
				: error instanceof Error
					? error.message
					: String(error),
			{ status },
		);
	}
};
