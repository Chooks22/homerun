import { fail, redirect } from "@sveltejs/kit";
import { config, isSmtpEnabled } from "#lib/config.js";
import { Logger } from "#lib/logger.js";
import { brandedEmail } from "#lib/server/email-layout.js";
import {
	checkbox,
	nullableText,
} from "#lib/server/validation/instance-settings-form.js";
import { EmailService } from "#lib/services/email.service.js";
import { InstanceSettingsService } from "#lib/services/instance-settings.service.js";
import { resolve } from "$app/paths";

const logger = new Logger("InstanceSettings");

export const actions = {
	sendTest: async ({ locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		if (!isSmtpEnabled()) {
			return fail(400, {
				error:
					"SMTP isn't configured yet : fill in the fields, save, then send a test.",
			});
		}
		const to = locals.user.email;
		try {
			await new EmailService({
				...brandedEmail({
					details: [
						{ name: "Instance", value: config.baseDomain },
						{ name: "SMTP host", value: config.smtp?.host ?? "—" },
					],
					heading: "Your email settings work",
					paragraphs: [
						"This is a test message from Homerun. Getting it means the saved SMTP settings work, and sign-in codes, invites and notifications will reach people.",
					],
				}),
				subject: "Homerun SMTP test",
				to,
			}).send();
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			logger.error(`SMTP test email failed: user=${locals.user.id} ${detail}`);
			return fail(400, { error: detail });
		}
		logger.info(`SMTP test email sent: user=${locals.user.id}`);
		return { success: true, testSentTo: to };
	},

	updateSmtp: async ({ request, locals }) => {
		if (!locals.user) {
			throw redirect(302, resolve("auth/sign-in"));
		}
		const formData = await request.formData();
		const portRaw = (formData.get("smtpPort") as string | null)?.trim();
		await InstanceSettingsService.saveSmtp(
			{
				smtpEnabled: checkbox(formData, "smtpEnabled"),
				smtpFrom: nullableText(formData, "smtpFrom"),
				smtpHost: nullableText(formData, "smtpHost"),
				smtpPassword:
					(formData.get("smtpPassword") as string | null)?.trim() || undefined,
				smtpPort: portRaw ? Number.parseInt(portRaw, 10) : null,
				smtpSecure: checkbox(formData, "smtpSecure"),
				smtpUser: nullableText(formData, "smtpUser"),
			},
			locals.user.id,
		);
		return { savedSection: "smtp", success: true };
	},
};
