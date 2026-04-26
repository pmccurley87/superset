import { randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { terminalSessions, workspaces } from "../../../db/schema";
import {
	createTerminalSessionInternal,
	disposeSession,
	listTerminalSessions,
	parseThemeType,
} from "../../../terminal/terminal";
import { listV1Sessions } from "../../../terminal/terminal-host-bridge";
import { protectedProcedure, router } from "../../index";

export const terminalRouter = router({
	listAll: protectedProcedure.query(async () => {
		const [v2, v1] = await Promise.all([
			listTerminalSessions({ includeExited: false }),
			listV1Sessions(),
		]);
		const v1Mapped = v1.map((s) => ({
			terminalId: `v1:${s.sessionId}`,
			workspaceId: s.workspaceId,
			cwd: "",
			createdAt: s.createdAt,
			exited: !s.isAlive,
			exitCode: 0,
			attached: false,
			source: "v1" as const,
		}));
		return { sessions: [...v2, ...v1Mapped] };
	}),

	open: protectedProcedure
		.input(
			z.object({
				workspaceId: z.string().optional(),
				worktreePath: z.string(),
				themeType: z.string().optional(),
			}),
		)
		.mutation(({ ctx, input }) => {
			const terminalId = randomBytes(8).toString("hex");
			const result = createTerminalSessionInternal({
				terminalId,
				workspaceId: input.workspaceId ?? null,
				worktreePath: input.worktreePath,
				themeType: parseThemeType(input.themeType),
				db: ctx.db,
				eventBus: ctx.eventBus,
			});

			if ("error" in result) {
				return { terminalId, status: "error" as const, error: result.error };
			}

			return { terminalId: result.terminalId, status: "active" as const };
		}),

	ensureSession: protectedProcedure
		.input(
			z.object({
				terminalId: z.string(),
				workspaceId: z.string(),
				themeType: z.string().optional(),
				initialCommand: z.string().optional(),
			}),
		)
		.mutation(({ ctx, input }) => {
			const result = createTerminalSessionInternal({
				terminalId: input.terminalId,
				workspaceId: input.workspaceId,
				themeType: parseThemeType(input.themeType),
				db: ctx.db,
				eventBus: ctx.eventBus,
				initialCommand: input.initialCommand,
			});

			if ("error" in result) {
				return {
					terminalId: input.terminalId,
					status: "error" as const,
					error: result.error,
				};
			}

			return { terminalId: result.terminalId, status: "active" as const };
		}),

	listSessions: protectedProcedure
		.input(
			z.object({
				workspaceId: z.string(),
			}),
		)
		.query(({ input }) => ({
			sessions: listTerminalSessions({
				workspaceId: input.workspaceId,
				includeExited: false,
			}),
		})),

	killSession: protectedProcedure
		.input(
			z.object({
				terminalId: z.string(),
				workspaceId: z.string(),
			}),
		)
		.mutation(({ ctx, input }) => {
			const workspace = ctx.db.query.workspaces
				.findFirst({ where: eq(workspaces.id, input.workspaceId) })
				.sync();

			if (!workspace) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Workspace not found",
				});
			}

			const session = ctx.db.query.terminalSessions
				.findFirst({ where: eq(terminalSessions.id, input.terminalId) })
				.sync();

			if (!session) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Terminal session not found",
				});
			}

			if (session.originWorkspaceId !== input.workspaceId) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Terminal session does not belong to this workspace",
				});
			}

			disposeSession(input.terminalId, ctx.db);
			return { terminalId: input.terminalId, status: "disposed" as const };
		}),
});
