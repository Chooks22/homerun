import { WorkstationPresetDTO } from "#lib/dto/workstation-preset-dto.js";

export const load = async ({ parent }) => {
	const { user } = await parent();
	const presets = await WorkstationPresetDTO.listForUser(user.id);
	return { presets: presets.map((p) => p.toJSON()) };
};
