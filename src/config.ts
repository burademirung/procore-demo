import { z } from "zod";

/**
 * Centralized, validated configuration.
 *
 * We validate at boot so a misconfigured deployment fails fast and loudly rather
 * than throwing opaque 401s deep inside an API client at request time.
 *
 * On Cloudflare Workers there is no `process.env`; pass an env object explicitly.
 * On Node we default to `process.env`.
 */
const ConfigSchema = z.object({
  port: z.coerce.number().default(8788),
  // MCP spec MUST: validate Origin on Streamable HTTP to prevent DNS rebinding.
  mcpAllowedOrigins: z
    .string()
    .default("http://localhost,http://127.0.0.1")
    .transform((s) => s.split(",").map((o) => o.trim()).filter(Boolean)),
  rsTokensEncKey: z.string().optional(),
  // Shared secret for verifying inbound webhook HMAC signatures. REQUIRED to enable webhooks: the
  // webhook handlers fail closed (401) when this is unset, so a forged POST can't drive sync writes.
  // min(1) so an explicitly-empty value fails loudly rather than silently disabling verification.
  webhookSecret: z.string().min(1).optional(),

  procore: z.object({
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    redirectUri: z.string().optional(),
    authBase: z.string().default("https://login.procore.com"),
    apiBase: z.string().default("https://api.procore.com"),
    companyId: z.string().optional(),
  }),

  salesforce: z.object({
    loginUrl: z.string().default("https://login.salesforce.com"),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    username: z.string().optional(),
    jwtPrivateKey: z.string().optional(),
    redirectUri: z.string().optional(),
    apiVersion: z.string().default("v62.0"),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

type RawEnv = Record<string, string | undefined>;

export function loadConfig(env: RawEnv): Config {
  return ConfigSchema.parse({
    port: env.PORT,
    mcpAllowedOrigins: env.MCP_ALLOWED_ORIGINS,
    rsTokensEncKey: env.RS_TOKENS_ENC_KEY,
    webhookSecret: env.WEBHOOK_SECRET,
    procore: {
      clientId: env.PROCORE_CLIENT_ID,
      clientSecret: env.PROCORE_CLIENT_SECRET,
      redirectUri: env.PROCORE_REDIRECT_URI,
      authBase: env.PROCORE_AUTH_BASE,
      apiBase: env.PROCORE_API_BASE,
      companyId: env.PROCORE_COMPANY_ID,
    },
    salesforce: {
      loginUrl: env.SF_LOGIN_URL,
      clientId: env.SF_CLIENT_ID,
      clientSecret: env.SF_CLIENT_SECRET,
      username: env.SF_USERNAME,
      jwtPrivateKey: env.SF_JWT_PRIVATE_KEY,
      redirectUri: env.SF_REDIRECT_URI,
      apiVersion: env.SF_API_VERSION,
    },
  });
}
