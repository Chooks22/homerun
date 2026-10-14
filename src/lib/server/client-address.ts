/** The request's client address, or null when the adapter can't tell (a build-time or internal request). */
export function clientAddress(event: {
	getClientAddress: () => string;
}): string | null {
	try {
		return event.getClientAddress();
	} catch {
		return null;
	}
}
