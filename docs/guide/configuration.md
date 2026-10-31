# Configuration

Every environment variable the factory reads, including the brain
providers and the memory vault. Back to the [README](../../README.md).

Copy `.env.example` to `.env` and fill it in. Bun loads `.env` for
`bun test`, so the integration smokes read it directly.

| Variable | What it is |
| --- | --- |
| `FACTORY_BRAIN_GATEWAY` | Set to `1` to use the JigJoy gateway as the brain's first provider (Claude credits are kept for the demo); otherwise Z.ai is primary and the `JIGJOY_*` keys are ignored |
| `JIGJOY_ANTHROPIC_API_KEY`, `JIGJOY_ANTHROPIC_BASE_URL` | Anthropic gateway (JigJoy), read only when `FACTORY_BRAIN_GATEWAY=1`, then both are required; Z.ai becomes the fallback, taken automatically for 60 s after a rate limit or outage and for 30 min after the gateway refuses the key or the balance. The `ANTHROPIC_*` names are never read, so Claude Code does not pick the gateway up |
| `FACTORY_MOZAIK_CLOUD`, `MOZAIK_API_KEY`, `MOZAIK_PROJECT_ID`, `MOZAIK_REDACTION` | Optional, opt-in: with `FACTORY_MOZAIK_CLOUD=1` and a Mozaik key, the brain's loop events (spec text, task descriptions, redacted executor reports) are sent to Mozaik Cloud and the live link is printed; `MOZAIK_REDACTION` defaults to `content` (texts sent as sizes only), `none` sends them in full; a key without the opt-in makes the brain refuse to start. Tests never export unless `FACTORY_TEST_MOZAIK_CLOUD=1` |
| `JIGJOY_ANTHROPIC_MODEL` | Model behind the gateway; optional, defaults to `claude-sonnet-4-6`; must differ from `ZAI_MODEL` (calls are routed by model name) |
| `ZAI_API_KEY` | API key of the brain model's OpenAI-compatible endpoint |
| `ZAI_BASE_URL` | Base URL of that endpoint; optional, defaults to `https://api.z.ai/api/coding/paas/v4` |
| `ZAI_MODEL` | Model id the brain uses; optional, defaults to `glm-5.3-flash` |
| `FALLBACK_API_KEY`, `FALLBACK_BASE_URL`, `FALLBACK_MODEL` | Optional second provider, used when the providers before it are rate-limited, down or refused; an OpenAI-compatible model with function calling and streaming, like the primary; set all three or none; `FALLBACK_MODEL` must differ from `ZAI_MODEL` and from `JIGJOY_ANTHROPIC_MODEL` (calls are routed by model name) |
| `FACTORY_OSB_VAULT` | Absolute path of the factory's own Open Second Brain vault |
| `FACTORY_OSB_CONFIG` | Absolute path of the Open Second Brain config file for that vault |

Keys stay in `.env`, which git ignores; never commit them.

How to create the vault the last two variables point to:
[A dedicated memory vault](setup.md#a-dedicated-memory-vault).
