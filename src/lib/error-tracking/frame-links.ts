import type { StoredErrorEvent } from "./event";
import {
	repoRelativePath,
	type SourceProvider,
	sourceFileUrl,
} from "./source-links";

export interface FrameLinkSource {
	branch?: boolean;
	buildContext: string | null;
	commit: string;
	provider: SourceProvider;
	repoUrl: string;
}

/**
 * Repository links for an event's in-app frames, keyed
 * `<exception index>:<frame index>`. A frame whose file can't be mapped to a
 * repository path gets none.
 */
export function frameLinks(
	event: Pick<StoredErrorEvent, "exceptions">,
	source: FrameLinkSource | null,
): Record<string, string> {
	const links: Record<string, string> = {};
	if (!source) {
		return links;
	}
	event.exceptions.forEach((exception, exceptionIndex) => {
		exception.frames.forEach((frame, frameIndex) => {
			if (!frame.inApp) {
				return;
			}
			const path =
				repoRelativePath(frame.absPath, source.buildContext) ??
				repoRelativePath(frame.filename, source.buildContext);
			if (path) {
				links[`${exceptionIndex}:${frameIndex}`] = sourceFileUrl({
					branch: source.branch,
					commit: source.commit,
					line: frame.lineno,
					path,
					provider: source.provider,
					repoUrl: source.repoUrl,
				});
			}
		});
	});
	return links;
}
