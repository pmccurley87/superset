import { z } from "zod";

const envSchema = z.object({
	NODE_ENV: z
		.enum(["development", "production", "test"])
		.default("development"),
	EXPO_PUBLIC_API_URL: z.url(),
	EXPO_PUBLIC_HOST_IP: z.string().optional(),
	EXPO_PUBLIC_HOST_PORT: z.string().optional(),
	EXPO_PUBLIC_HOST_SECRET: z.string().optional(),
	EXPO_PUBLIC_WEB_URL: z.url().optional(),
	EXPO_PUBLIC_DEEP_LINK_SCHEME: z.string().default("superset"),
	EXPO_PUBLIC_DEEP_LINK_DOMAIN: z.string().optional(),
	EXPO_PUBLIC_POSTHOG_KEY: z.string(),
	EXPO_PUBLIC_POSTHOG_HOST: z.url().default("https://us.i.posthog.com"),
});

export const env = envSchema.parse({
	NODE_ENV: process.env.NODE_ENV as unknown,
	EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL as unknown,
	EXPO_PUBLIC_HOST_IP: process.env.EXPO_PUBLIC_HOST_IP as unknown,
	EXPO_PUBLIC_HOST_PORT: process.env.EXPO_PUBLIC_HOST_PORT as unknown,
	EXPO_PUBLIC_HOST_SECRET: process.env.EXPO_PUBLIC_HOST_SECRET as unknown,
	EXPO_PUBLIC_WEB_URL: process.env.EXPO_PUBLIC_WEB_URL as unknown,
	EXPO_PUBLIC_DEEP_LINK_SCHEME: process.env
		.EXPO_PUBLIC_DEEP_LINK_SCHEME as unknown,
	EXPO_PUBLIC_DEEP_LINK_DOMAIN: process.env
		.EXPO_PUBLIC_DEEP_LINK_DOMAIN as unknown,
	EXPO_PUBLIC_POSTHOG_KEY: process.env.EXPO_PUBLIC_POSTHOG_KEY as unknown,
	EXPO_PUBLIC_POSTHOG_HOST: process.env.EXPO_PUBLIC_POSTHOG_HOST as unknown,
});
