function superJson(input: unknown) {
	return { json: input };
}

export async function trpc<T>(
	base: string,
	secret: string,
	proc: string,
	input: unknown = {},
): Promise<T> {
	const qs = encodeURIComponent(JSON.stringify({ "0": superJson(input) }));
	const res = await fetch(`${base}/trpc/${proc}?batch=1&input=${qs}`, {
		headers: secret ? { Authorization: `Bearer ${secret}` } : {},
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	type BatchResult =
		| { result: { data: { json: T } } }
		| { error: { json: { message: string } } };
	const body = (await res.json()) as BatchResult[];
	const item = body[0];
	if (!item) throw new Error("Empty response");
	if ("error" in item) throw new Error(item.error.json.message);
	return item.result.data.json;
}

export async function trpcPost<T>(
	base: string,
	secret: string,
	proc: string,
	input: unknown = {},
): Promise<T> {
	const res = await fetch(`${base}/trpc/${proc}?batch=1`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(secret ? { Authorization: `Bearer ${secret}` } : {}),
		},
		body: JSON.stringify({ "0": superJson(input) }),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	type BatchResult =
		| { result: { data: { json: T } } }
		| { error: { json: { message: string } } };
	const body = (await res.json()) as BatchResult[];
	const item = body[0];
	if (!item) throw new Error("Empty response");
	if ("error" in item) throw new Error(item.error.json.message);
	return item.result.data.json;
}
