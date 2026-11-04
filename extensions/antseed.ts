/**
 * pi-antseed
 *
 * Registers an Antseed endpoint as a protocol-aware pi provider. The endpoint is
 * either an Antseed gateway (recommended: https://gateway.example.com/v1, or
 * http://localhost:8379/v1 for a gateway on this computer, with a gateway API
 * key) or the local buyer proxy (http://localhost:8377, same computer only).
 *
 * The extension reads `GET /v1/models?type=text`, which both serve, learns
 * which API protocol each seller's service speaks, registers one pi model per
 * service/peer route and dispatches each request through the matching pi-ai
 * provider implementation, pinned to that peer with `x-antseed-pin-peer`.
 * Buyers too old to list peers in `/v1/models` fall back to `/_antseed/peers`.
 *
 * Configuration:
 *   ANTSEED_BASE_URL  endpoint root or /v1 URL (default http://localhost:8377)
 *   ANTSEED_API_KEY   gateway API key, sent as Authorization: Bearer (required by a gateway)
 *   ANTSEED_MODELS    optional comma-separated allow-list of service IDs or route IDs
 */
import type { ExtensionAPI, ProviderModelConfig } from "@mariozechner/pi-coding-agent";
import { getApiProvider, type Api, type Context, type Model, type SimpleStreamOptions } from "@mariozechner/pi-ai";

type AntseedApi = Extract<Api, "anthropic-messages" | "openai-completions" | "openai-responses">;
type AntseedNetworkProtocol = AntseedApi | "openai-chat-completions";
type AntseedAutoApi = "antseed-network";

const AUTO_API: AntseedAutoApi = "antseed-network";
const DEFAULT_BASE_URL = "http://localhost:8377";
const BASE_URL = process.env.ANTSEED_BASE_URL ?? DEFAULT_BASE_URL;
const DISCOVERY_TIMEOUT_MS = 10_000;
const PIN_PEER_HEADER = "x-antseed-pin-peer";

interface ModelSpec {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
}

export interface AntseedRoute {
	api: AntseedApi;
	peerId: string;
	peerName: string | null;
	serviceId: string;
	reputation: number;
	categories: Set<string>;
	/** Seller-advertised capabilities; undefined when the seller does not say. */
	contextWindow?: number;
	maxTokens?: number;
	images?: boolean;
	reasoning?: boolean;
}

const DEFAULT_CONTEXT_WINDOW = 400_000;
const DEFAULT_MAX_TOKENS = 16_384;

let modelRoutes = new Map<string, AntseedRoute>();

function stripTrailingSlashes(url: string): string {
	return url.replace(/\/+$/, "");
}

function proxyRootUrl(): string {
	return stripTrailingSlashes(BASE_URL.trim() || DEFAULT_BASE_URL).replace(/\/v1$/i, "");
}

function openAiBaseUrl(): string {
	return `${proxyRootUrl()}/v1`;
}

function baseUrlForApi(api: AntseedApi): string {
	return api === "anthropic-messages" ? proxyRootUrl() : openAiBaseUrl();
}

function modelsUrl(): string {
	return `${openAiBaseUrl()}/models?type=text`;
}

function peersUrl(): string {
	return `${proxyRootUrl()}/_antseed/peers`;
}

function apiKey(): string | null {
	return process.env.ANTSEED_API_KEY?.trim() || null;
}

function serviceKey(service: string): string {
	return service.trim().toLowerCase();
}

export function makeModel(id: string, route: AntseedRoute): ModelSpec {
	return {
		id,
		name: routeDisplayName(route),
		reasoning: supportsReasoning(route),
		input: supportsImages(route) ? ["text", "image"] : ["text"],
		contextWindow: route.contextWindow ?? inferContextWindow(route.serviceId),
		maxTokens: route.maxTokens ?? DEFAULT_MAX_TOKENS,
	};
}

function routeDisplayName(route: AntseedRoute): string {
	const peerLabel = route.peerName
		? `${route.peerName} (${route.peerId.slice(0, 8)})`
		: route.peerId.slice(0, 12);
	const rep = Number.isFinite(route.reputation) ? ` · rep ${Math.round(route.reputation)}` : "";
	return `${route.serviceId} @ ${peerLabel}${rep} (Antseed)`;
}

function supportsReasoning(route: AntseedRoute): boolean {
	if (route.api === "openai-completions") return false;
	return route.reasoning ?? hasAnyCategory(route, ["reasoning", "thinking"]);
}

function supportsImages(route: AntseedRoute): boolean {
	return route.images ?? hasAnyCategory(route, ["multimodal", "vision", "image", "images"]);
}

function hasAnyCategory(route: AntseedRoute, categories: string[]): boolean {
	return categories.some((category) => route.categories.has(category));
}

function inferContextWindow(id: string): number {
	const match = id.toLowerCase().match(/(?:^|[-_.])(\d+(?:\.\d+)?)([km])(?:$|[-_.])/);
	if (!match) return DEFAULT_CONTEXT_WINDOW;

	const value = Number(match[1]);
	if (!Number.isFinite(value) || value <= 0) return DEFAULT_CONTEXT_WINDOW;
	return Math.round(value * (match[2] === "m" ? 1_000_000 : 1_000));
}

function toProviderModel(model: ModelSpec): ProviderModelConfig {
	return {
		...model,
		api: AUTO_API,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
	const n = finiteNumber(value);
	return n !== undefined && n > 0 ? Math.floor(n) : undefined;
}

function stringList(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string").map((item) => item.trim().toLowerCase()).filter(Boolean)
		: [];
}

function isNetworkProtocol(value: unknown): value is AntseedNetworkProtocol {
	return value === "anthropic-messages"
		|| value === "openai-responses"
		|| value === "openai-chat-completions"
		|| value === "openai-completions";
}

function toPiApi(protocol: AntseedNetworkProtocol): AntseedApi {
	return protocol === "openai-chat-completions" ? "openai-completions" : protocol;
}

function chooseApi(protocols: unknown[]): AntseedApi | null {
	const supported = protocols.filter(isNetworkProtocol);
	if (supported.length === 0) return null;

	// Prefer lossless/stateful protocols when a seller advertises multiple options.
	for (const protocol of ["openai-responses", "anthropic-messages", "openai-chat-completions", "openai-completions"] as const) {
		if (supported.includes(protocol)) return toPiApi(protocol);
	}
	return toPiApi(supported[0]!);
}

function routeRank(api: AntseedApi): number {
	if (api === "openai-responses") return 0;
	if (api === "anthropic-messages") return 1;
	return 2;
}

const PEER_ID_PREFIX_LENGTH = 12;
const PEER_NAME_SLUG_MAX = 24;

function slugifyPeerName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, PEER_NAME_SLUG_MAX);
}

/**
 * Stable pi model id: `<service>@<peer-prefix>[-<peer-name>]`. Reputation is
 * left out on purpose: it changes over time and would break saved defaults.
 */
export function routeModelId(service: string, peerId: string, peerName: string | null): string {
	const slug = peerName ? slugifyPeerName(peerName) : "";
	return `${service}@${peerId.slice(0, PEER_ID_PREFIX_LENGTH)}${slug ? `-${slug}` : ""}`;
}

function addRoute(routes: Map<string, AntseedRoute>, route: AntseedRoute): void {
	const key = serviceKey(routeModelId(route.serviceId, route.peerId, route.peerName));
	const existing = routes.get(key);
	if (!existing) {
		routes.set(key, route);
		return;
	}

	for (const category of route.categories) existing.categories.add(category);
	if (routeRank(route.api) < routeRank(existing.api)) existing.api = route.api;
}

function normalizePeerId(value: unknown): string | null {
	const peerId = typeof value === "string" ? value.trim().toLowerCase().replace(/^0x/, "") : "";
	return /^[0-9a-f]{40}$/.test(peerId) ? peerId : null;
}

function peerDisplayName(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function peerReputation(peer: Record<string, unknown>): number {
	return finiteNumber(peer.effectiveReputationScore)
		?? finiteNumber(peer.onChainReputationScore)
		?? finiteNumber(peer.reputationScore)
		?? Number.NEGATIVE_INFINITY;
}

/**
 * Routes from a `GET /v1/models` body. Returns null when no model lists its
 * peers (a buyer too old to include them), so the caller can fall back.
 */
export function routesFromModelList(body: unknown): Map<string, AntseedRoute> | null {
	const data = asRecord(body)?.data;
	if (!Array.isArray(data)) return null;

	const routes = new Map<string, AntseedRoute>();
	let sawPeers = false;
	for (const rawModel of data) {
		const model = asRecord(rawModel);
		if (!model || !Array.isArray(model.peers)) continue;
		sawPeers = true;
		if (model.type !== undefined && model.type !== "text") continue;

		for (const rawPeer of model.peers) {
			const peer = asRecord(rawPeer);
			if (!peer) continue;
			const peerId = normalizePeerId(peer.peerId);
			const serviceId = typeof peer.serviceId === "string" && peer.serviceId.trim()
				? peer.serviceId.trim()
				: typeof model.id === "string" ? model.id : "";
			if (!peerId || !serviceId) continue;

			const protocols = Array.isArray(peer.protocols) && peer.protocols.length > 0 ? peer.protocols : [peer.protocol];
			const api = chooseApi(protocols);
			if (!api) continue;

			const capabilities = asRecord(peer.capabilities);
			const inputs = capabilities ? stringList(capabilities.inputs) : [];
			addRoute(routes, {
				api,
				peerId,
				peerName: peerDisplayName(peer.displayName),
				serviceId,
				reputation: peerReputation(peer),
				categories: new Set(stringList(peer.categories)),
				contextWindow: positiveInteger(capabilities?.contextWindow),
				maxTokens: positiveInteger(capabilities?.maxOutputTokens),
				images: inputs.length > 0 ? inputs.includes("image") : undefined,
				reasoning: typeof capabilities?.reasoning === "boolean" ? capabilities.reasoning : undefined,
			});
		}
	}
	return sawPeers ? routes : null;
}

/** Routes from the buyer proxy's `GET /_antseed/peers` (older buyers only). */
export function routesFromPeerList(body: unknown): Map<string, AntseedRoute> {
	const peers = asRecord(body)?.peers;
	const routes = new Map<string, AntseedRoute>();
	if (!Array.isArray(peers)) return routes;

	for (const rawPeer of peers) {
		const peer = asRecord(rawPeer);
		const peerId = normalizePeerId(peer?.peerId);
		const matrix = asRecord(peer?.providerServiceApiProtocols);
		if (!peer || !peerId || !matrix) continue;

		for (const [provider, rawEntry] of Object.entries(matrix)) {
			const services = asRecord(asRecord(rawEntry)?.services);
			if (!services) continue;
			const categories = asRecord(asRecord(asRecord(peer.providerServiceCategories)?.[provider])?.services);

			for (const [serviceId, rawProtocols] of Object.entries(services)) {
				const api = Array.isArray(rawProtocols) ? chooseApi(rawProtocols) : null;
				if (!api) continue;
				addRoute(routes, {
					api,
					peerId,
					peerName: peerDisplayName(peer.displayName),
					serviceId,
					reputation: peerReputation(peer),
					categories: new Set(stringList(categories?.[serviceId])),
				});
			}
		}
	}
	return routes;
}

class HttpError extends Error {
	constructor(readonly status: number, statusText: string) {
		super(`HTTP ${status} ${statusText}`);
	}
}

async function fetchJson(url: string): Promise<unknown> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
	const key = apiKey();
	try {
		const response = await fetch(url, {
			signal: controller.signal,
			headers: key ? { authorization: `Bearer ${key}` } : {},
		});
		if (!response.ok) throw new HttpError(response.status, response.statusText);
		return await response.json();
	} finally {
		clearTimeout(timeout);
	}
}

async function fetchNetworkRoutes(): Promise<Map<string, AntseedRoute>> {
	const fromModels = routesFromModelList(await fetchJson(modelsUrl()));
	if (fromModels) return fromModels;
	// Only a local buyer serves /_antseed/peers; a gateway always lists peers in /v1/models.
	return routesFromPeerList(await fetchJson(peersUrl()));
}

function configuredModelAllowList(): Set<string> | null {
	const raw = process.env.ANTSEED_MODELS;
	if (!raw) return null;
	return new Set(raw.split(",").map((id) => serviceKey(id)).filter(Boolean));
}

export function sortRoutes(entries: [string, AntseedRoute][]): [string, AntseedRoute][] {
	// Reputation descending (unknown last), then a peer's services together, then service id.
	return entries.sort(([, a], [, b]) => {
		if (a.reputation !== b.reputation) return b.reputation - a.reputation;
		const peerLabelA = a.peerName ?? a.peerId;
		const peerLabelB = b.peerName ?? b.peerId;
		if (peerLabelA !== peerLabelB) return peerLabelA.localeCompare(peerLabelB);
		return a.serviceId.localeCompare(b.serviceId);
	});
}

async function discoverModels(): Promise<ModelSpec[]> {
	const routes = await fetchNetworkRoutes();
	const allowList = configuredModelAllowList();
	if (allowList) {
		for (const [key, route] of [...routes.entries()]) {
			if (!allowList.has(key) && !allowList.has(serviceKey(route.serviceId))) routes.delete(key);
		}
	}

	modelRoutes = routes;
	return sortRoutes([...routes.entries()]).map(([id, route]) => makeModel(id, route));
}

function routeForModel(id: string): AntseedRoute {
	const route = modelRoutes.get(serviceKey(id));
	if (!route) {
		throw new Error(`[pi-antseed] No Antseed route found for model ${id}. Run /reload to refresh the model list.`);
	}
	return route;
}

function routedModel<TApi extends AntseedApi>(model: Model<Api>, route: AntseedRoute): Model<TApi> {
	return {
		...model,
		id: route.serviceId,
		api: route.api,
		baseUrl: baseUrlForApi(route.api),
		reasoning: route.api === "openai-completions" ? false : model.reasoning,
	} as Model<TApi>;
}

function routedOptions(route: AntseedRoute, options?: SimpleStreamOptions): SimpleStreamOptions {
	return {
		...options,
		headers: {
			...options?.headers,
			[PIN_PEER_HEADER]: route.peerId,
		},
	};
}

function streamAntseed(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
	const route = routeForModel(model.id);
	const provider = getApiProvider(route.api);
	if (!provider) throw new Error(`[pi-antseed] No pi-ai provider registered for API ${route.api}`);
	return provider.streamSimple(routedModel(model, route), context, routedOptions(route, options));
}

function discoveryFailureHint(err: unknown): string {
	if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
		return apiKey()
			? " The endpoint rejected ANTSEED_API_KEY: check that the gateway key is valid and not revoked."
			: " The endpoint needs an API key: set ANTSEED_API_KEY to your gateway key.";
	}
	return " Check that ANTSEED_BASE_URL points at a running Antseed gateway or buyer proxy, then run /reload.";
}

export default async function (pi: ExtensionAPI) {
	try {
		const models = await discoverModels();
		if (models.length === 0) {
			console.warn(`[pi-antseed] ${proxyRootUrl()} lists no text models yet. Wait for sellers to be discovered, then run /reload.`);
			return;
		}

		pi.registerProvider("antseed", {
			baseUrl: proxyRootUrl(),
			// The key's value, not the env var's name: pi before 1.0 reads a bare name as an env var,
			// pi 1.x only reads `$NAME`, and both pass a plain value through unchanged.
			apiKey: apiKey() ?? "antseed-local",
			api: AUTO_API,
			streamSimple: streamAntseed,
			authHeader: true,
			models: models.map(toProviderModel),
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`[pi-antseed] Could not load Antseed models from ${modelsUrl()}: ${message}.${discoveryFailureHint(err)}`);
	}
}
