# Optional Workers AI document enhancement

PidginDocs can use Cloudflare Workers AI for Markdown `polish` and `enrich` jobs.
The binding is optional. Add this block to the Wrangler configuration for the
environment where the feature should be enabled:

```toml
[ai]
binding = "AI"
```

Then regenerate Worker types from that configuration with
`npx wrangler types --config wrangler.toml` (substitute
`wrangler.production.toml` when that is the configuration you changed). The
server's enhancement code accepts the Workers AI binding when present.
Without it, `polish` and `enrich` continue to use Anthropic when
`ANTHROPIC_API_KEY` is configured. `research` always uses
Anthropic's server-side web-search tool and still requires that key.

The configured model has a 24,000-token context window. Since Workers AI does
not expose a tokenizer through this binding, PidginDocs uses prompt UTF-8 bytes as
a conservative input bound, reserves 512 tokens for message framing, and sizes
the output budget against the source Markdown (with extra room for `enrich`).
If the prompt cannot fit that budget, the enhancement fails before inference;
it does not fall back to a second paid provider.

Workers AI inference can incur usage charges. Local tests stub the model call;
running an actual Workers AI inference through `wrangler dev` contacts
Cloudflare and is billable. See Cloudflare's [Workers AI binding guide](https://developers.cloudflare.com/workers-ai/configuration/bindings/)
and the [Llama 3.3 70B FP8 Fast model reference](https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/).
