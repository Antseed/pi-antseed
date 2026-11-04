# pi-antseed

Use [Antseed](https://antseed.com) as a model provider in [pi](https://shittycodingagent.ai).

The extension registers a protocol-aware pi provider named `antseed`. It lists
every text model sellers offer on the Antseed network, one entry per model and
seller, and sends each request in the API format that seller speaks: Anthropic
Messages, OpenAI Chat Completions or OpenAI Responses. You switch models with
`/model antseed/<id>` like any built-in provider.

---

## Install

Works with pi 1.x (`@earendil-works/pi-coding-agent`, npm or the standalone
binary) and with the older `@mariozechner/pi-coding-agent`.

```bash
# From GitHub
pi install git:github.com/AntSeed/pi-antseed

# Or try without installing
pi -e git:github.com/AntSeed/pi-antseed

# From a local clone
pi install ./pi-antseed
```

Then point it at an Antseed endpoint (next section) and restart pi or run `/reload`.
To update an installed copy, run `pi update`.

---

## Connect

### Recommended: a gateway

A [gateway](https://antseed.com/docs/gateway) gives pi its own API key, with
budgets, routing policies and usage logs. Run it on a small server (one command,
see [Run a gateway on a server](https://antseed.com/docs/gateway/server)): it
stays on when your laptop sleeps, and pi on any machine uses the same HTTPS URL.

```bash
export ANTSEED_BASE_URL="https://gateway.example.com/v1"   # or http://localhost:8379/v1 for a gateway on this computer
export ANTSEED_API_KEY="antseed_…"                         # a gateway API key
pi
```

- Just trying it out? The [quickstart](https://antseed.com/docs/quickstart) also
  sets one up on your computer (`http://localhost:8379/v1`).
- Gateway on your own computer, pi somewhere else? Publish the gateway at a
  public HTTPS address with a [tunnel](https://antseed.com/docs/tunnels):
  `antseed tunnel start`, or **Agents → Internet-accessible endpoint** in the
  desktop app. Use the tunnel's base URL ending in `/v1` and its API key.
- Paid models need funds in the gateway's wallet: see
  [Funding](https://antseed.com/docs/gateway/funding). Free models work right away.

### Alternative: the local buyer proxy (same computer only)

If pi runs on the same computer as an Antseed buyer (the desktop app or
`antseed buyer start`), it can use the buyer proxy directly. This is the
default, so no settings are needed:

```bash
# ANTSEED_BASE_URL defaults to http://localhost:8377
pi
```

The buyer proxy has no API keys and listens only on `127.0.0.1`. Never expose
port 8377 to other machines: anyone who reaches it can spend your deposit. For
pi on another machine, use a gateway or a tunnel instead.

---

## Use it in pi

Open the model selector with `Ctrl+L` (or `/model`) and pick an Antseed route:

```
antseed/<service-id>@<peer-prefix>[-<peer-name>]
```

For example (fictional sellers):

```
antseed/minimax-m2.7@aaaaaaaaaaaa-acme-inference
antseed/deepseek-v4-flash@aaaaaaaaaaaa-acme-inference
antseed/deepseek-v4-flash@bbbbbbbbbbbb
```

`<peer-prefix>` is the first 12 characters of the seller's peer id, followed by
its display name when it has one. Ids stay the same as reputation changes, so a
saved default model keeps working. The display name in the selector shows the
seller's reputation, and routes are listed highest reputation first.

Every request goes to the seller of the route you picked. To list only some
models, set `ANTSEED_MODELS`:

```bash
ANTSEED_MODELS="minimax-m2.7,deepseek-v4-flash" pi
```

Entries match a service id (every seller of that model) or a full route id
such as `minimax-m2.7@aaaaaaaaaaaa-acme-inference`.

---

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `ANTSEED_BASE_URL` | `http://localhost:8377` | The gateway or buyer proxy. The root URL or the `/v1` URL both work. |
| `ANTSEED_API_KEY` | _(unset)_ | Gateway API key, sent as `Authorization: Bearer`. Required by a gateway or tunnel; the local buyer proxy ignores it. |
| `ANTSEED_MODELS` | every text model | Optional comma-separated allow-list of service ids or full route ids. |

---

## Troubleshooting

- **pi says "No models available. Use /login…" and Antseed is not under `/login`**:
  the extension adds its models when pi starts; it is not a `/login` provider.
  pi shows this when the extension loaded none. Run `pi update` (versions before
  0.2.0 could not read a gateway), set `ANTSEED_API_KEY` next to
  `ANTSEED_BASE_URL`, restart pi and read the `[pi-antseed]` line it prints.
- **`HTTP 401` at startup**: the gateway needs a key. Set `ANTSEED_API_KEY`
  to a gateway API key (not an ngrok or Cloudflare token), and check that the
  key is not revoked or expired.
- **No `antseed/...` models in pi**: pi prints a `[pi-antseed]` warning at
  startup that says why. Check that `ANTSEED_BASE_URL` points at a running
  gateway or buyer, and that it lists models:
  `curl "$ANTSEED_BASE_URL/models?type=text" -H "Authorization: Bearer $ANTSEED_API_KEY"`.
  Then run `/reload`.
- **The list is empty right after the buyer starts**: it has not found
  sellers yet. Wait a few seconds and run `/reload`.
- **`Connection refused` on another machine**: the buyer proxy only accepts
  local connections. Use a gateway or a tunnel.
- **`402` / `insufficient_deposits`**: the wallet has no funds for paid models.
  See [Funding](https://antseed.com/docs/gateway/funding).
- **A route fails mid-conversation**: that seller has gone offline or no
  longer offers the model, or the key's routing policy does not allow it. Run
  `/reload` and pick another route.

---

## How it works

`extensions/antseed.ts` registers one provider, `antseed`, with a small custom
`streamSimple` dispatcher. On load (and on `/reload`) it reads
`GET /v1/models?type=text`, which gateways and buyer proxies both serve. Each
model lists the sellers that offer it, with the API protocols they speak, their
reputation and, when the seller says, the context window, maximum output
tokens and image input. The extension registers each model/seller pair as a pi
model. Buyers too old to list sellers there fall back to `/_antseed/peers`.

On each request it sends `x-antseed-pin-peer: <peerId>` so the request goes to
the chosen seller, picks the pi-ai provider for that seller's protocol, and
uses the matching base URL:

- `anthropic-messages` → the root URL, because pi appends `/v1/messages`.
- `openai-responses` / `openai-chat-completions` → the `/v1` URL.

A gateway applies the key's budgets and routing policy to the pinned seller.
Antseed handles the connection to the seller, payment channels, translation
between API formats and metering.
