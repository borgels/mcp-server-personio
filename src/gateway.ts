import { z } from 'zod/v4';
import { ActAsRefusedError, actAsRefusalInForm, normaliseActAs, type ActAs, type ActAsRefusal } from './act-as.js';
import { ConfigError } from './config-env.js';
import { failureMetadata, PersonioHttpError, vendorRequestId, type FailureMetadata } from './errors.js';
import { fixedOutputs, withheldAuditRecord, withheldResult } from './fallbacks.js';
import { admitsKey, keyRefusedText, leaksSecret, sealedError } from './key-admission.js';
import { PersonioClient } from './personio/client.js';
import { redactDeep, SecretRedactor } from './redaction.js';
import {
  findGatewayTool,
  GATEWAY_TOOLS,
  GatewayInputError,
  resolveSelf,
  type GatewayTool,
  type UpstreamOperation,
} from './gateway/tools.js';

/**
 * Embeddable entry point (package export `./gateway`), in the shape of
 * mcp-server-template: an embedding host, such as an MCP gateway that does
 * its own per-user authorization, lists `tools` and invokes `callTool`.
 *
 * The gateway has its own, curated tool table (src/gateway/tools.ts): a
 * company-wide HR surface with standard fields only. It never returns a
 * person's custom attributes (where national id numbers, bank details and
 * salary live), the type or comment of an absence, compensations, documents,
 * recruiting or custom reports, and it cannot delete anything or change a
 * person. Its two writes (an absence period, an attendance period) enter
 * Personio's normal approval workflow.
 *
 * One instance per Personio company. Several instances can run in one
 * process. An instance uses only the credentials passed to
 * createPersonioGateway and reads no PERSONIO_* variable: not the
 * credentials, PERSONIO_BASE_URL or PERSONIO_TIMEOUT_MS (options and
 * defaults instead), not PERSONIO_PROFILE, PERSONIO_ENABLE_WRITES or
 * PERSONIO_AUDIT_LOG (the host's `policy` instead; without it writes are off
 * and nothing is audited).
 *
 * Acting as the person (src/act-as.ts): the host may give `actAs` (the
 * person's verified email) in the call context. The self tools (catalog
 * `self: true`) need it: they find exactly one active person with that work
 * email and read or create only that person's own data. Without `actAs`, or
 * when no single active person has the address, a self tool sends nothing
 * and answers with `actAsRefused`; it never falls back to another person or
 * to the company-wide tools. The company-wide tools ignore `actAs`. The
 * email is never audited or put in a text of ours.
 *
 * Errors carry the HTTP status and our own text only, never Personio's
 * response body. Every output (results, errors, the tool list, audit
 * records) is redacted with the instance's own secrets and passes the sink
 * check (src/key-admission.ts) as it leaves.
 */

export const DEFAULT_BASE_URL = 'https://api.personio.de';

export { ACT_AS_REFUSALS, ACT_AS_TEXTS } from './act-as.js';

/** The person a call is made for (GatewayCallContext.actAs; see src/act-as.ts). */
export type GatewayActAs = ActAs;
/** Why a call was not made as the person: `invalid` actAs, `no_user` in Personio, or `not_permitted`. */
export type GatewayActAsRefusal = ActAsRefusal;
export const DEFAULT_TIMEOUT_MS = 30_000;

export type GatewayRiskLevel = 'read' | 'write' | 'destructive';
export type GatewayJsonValue = string | number | boolean | null | GatewayJsonValue[] | { [key: string]: GatewayJsonValue };
export type GatewayJsonObject = { [key: string]: GatewayJsonValue };

export interface GatewayToolDefinition {
  name: string;
  title: string;
  description: string;
  riskLevel: GatewayRiskLevel;
  enabledByDefault: boolean;
  inputSchema: GatewayJsonObject;
}

/**
 * Metadata about a failed call, on an error result whose cause is known: the HTTP status Personio answered with,
 * and its own request id when a response header gives one as a UUID or hex id. For a host that counts failures
 * without reading their text. Never the response body, the vendor's error code or message, or the input.
 */
export type GatewayFailure = FailureMetadata;

export interface GatewayToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: GatewayJsonValue;
  isError?: boolean;
  /** On an error result from Personio only: its HTTP status and request id (see GatewayFailure). */
  failure?: GatewayFailure;
  /**
   * On an error result only: the call was not made, because it could not be made as the person in `actAs` (a self
   * tool without a valid `actAs`, or no single active person with the email). The text is fixed and never holds the
   * email.
   */
  actAsRefused?: GatewayActAsRefusal;
}

export interface GatewayCallContext {
  /** The host's id for the person the call is made for. Never sent to Personio and never audited in clear. */
  caller?: string;
  /** The host's id for this call; goes into audit records. */
  requestId?: string;
  /**
   * The person the call is made for, as the host verified them (src/act-as.ts). Needed by the self tools, ignored by
   * the others. Never audited and never sent to Personio except as the filter that finds the person.
   */
  actAs?: GatewayActAs;
}

/** Deeply read-only JSON, as found in the frozen tool catalog. */
export type GatewayReadonlyJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly GatewayReadonlyJsonValue[]
  | { readonly [key: string]: GatewayReadonlyJsonValue };

export type GatewayUpstreamOperation = Readonly<UpstreamOperation>;

/** A tool catalog entry: the gateway definition plus the upstream requests the tool may make. */
export interface GatewayToolCatalogEntry {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly riskLevel: GatewayRiskLevel;
  readonly enabledByDefault: boolean;
  readonly inputSchema: { readonly [key: string]: GatewayReadonlyJsonValue };
  readonly upstream: readonly GatewayUpstreamOperation[];
  /** True when the tool can read more than its name says. False for every tool here. */
  readonly broad: boolean;
  /** True for a tool a person should confirm outside the chat. False for every tool here: none moves money. */
  readonly requiresConfirmation: boolean;
  /** True for a self tool: it works only on the person in `actAs` and takes no person in its input. */
  readonly self: boolean;
}

/** Receives one audit record. With a sink, a write runs only if its start record was accepted. */
export type AuditSink = (record: Readonly<Record<string, unknown>>) => void | Promise<void>;

/** Policy given by an embedding host for one gateway instance. */
export interface InstancePolicy {
  /** Allow the write tools. Default false. */
  enableWrites?: boolean;
  /** Tools turned off on this instance, with or without the personio_ prefix. Must name known tools. */
  disabledTools?: readonly string[];
  /**
   * Receives the audit records of this instance's calls; a write runs only if its start record was accepted. Without
   * it nothing is audited, as in mcp-server-template: a host that enables writes without a sink keeps its own record of
   * a change before it calls the tool.
   */
  audit?: AuditSink;
}

export interface PersonioGatewayOptions {
  /** The API credential's client id (Settings > Integrations > API credentials). Required. */
  clientId: string;
  /** The API credential's client secret. Required. */
  clientSecret: string;
  /** Default https://api.personio.de. Must be https (http only on loopback, for tests). */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Time limit per request. Default 30 seconds. */
  timeoutMs?: number;
  policy?: InstancePolicy;
}

/**
 * JSON Schema for a gateway tool, derived from its zod schema. `format` is
 * dropped: strict validators reject unknown formats, and zod checks the
 * values when the call runs.
 */
function toJsonSchema(tool: GatewayTool): GatewayJsonObject {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(tool.inputSchema, {
    io: 'input',
    override: ctx => {
      delete (ctx.jsonSchema as Record<string, unknown>).format;
    },
  }) as Record<string, unknown>;
  return schema as GatewayJsonObject;
}

function toDefinition(tool: GatewayTool): GatewayToolDefinition {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    riskLevel: tool.risk,
    enabledByDefault: tool.risk === 'read',
    inputSchema: toJsonSchema(tool),
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

/** All gateway tools, as definitions. */
export const personioGatewayTools: GatewayToolDefinition[] = GATEWAY_TOOLS.map(toDefinition);

/**
 * The tool catalog: every gateway tool with its definition and the upstream
 * requests it may make, deeply frozen. Hosts can build their own permission
 * model from it without creating an instance.
 */
export const personioToolCatalog: readonly GatewayToolCatalogEntry[] = deepFreeze(
  GATEWAY_TOOLS.map(tool => ({
    ...toDefinition(tool),
    upstream: tool.upstream.map(operation => ({ ...operation })),
    broad: false,
    requiresConfirmation: false,
    self: tool.self === true,
  })),
);

interface ResolvedPolicy {
  readonly enableWrites: boolean;
  readonly disabledTools: ReadonlySet<string>;
  readonly audit?: AuditSink;
}

function resolvePolicy(policy: InstancePolicy | undefined): ResolvedPolicy {
  if (policy === undefined) return { enableWrites: false, disabledTools: new Set() };
  if (policy === null || typeof policy !== 'object') throw new ConfigError('policy must be an object');
  if (policy.enableWrites !== undefined && typeof policy.enableWrites !== 'boolean') {
    throw new ConfigError('policy.enableWrites must be a boolean');
  }
  if (policy.disabledTools !== undefined && !Array.isArray(policy.disabledTools)) {
    throw new ConfigError('policy.disabledTools must be an array of tool names');
  }
  if (policy.audit !== undefined && typeof policy.audit !== 'function') {
    throw new ConfigError('policy.audit must be a function');
  }
  const disabled = new Set<string>();
  for (const [index, name] of (policy.disabledTools ?? []).entries()) {
    const tool = typeof name === 'string' ? findGatewayTool(name) : undefined;
    // The value is not quoted: a configuration value is never echoed.
    if (!tool) throw new ConfigError(`policy.disabledTools[${index}] is not a known tool.`);
    disabled.add(tool.name);
  }
  return Object.freeze({
    enableWrites: policy.enableWrites === true,
    disabledTools: disabled,
    ...(policy.audit ? { audit: policy.audit } : {}),
  });
}

function requiredClientId(options: PersonioGatewayOptions): string {
  const value: unknown = (options as Partial<PersonioGatewayOptions> | undefined)?.clientId;
  if (typeof value !== 'string' || !/^[\x21-\x7e]{8,200}$/.test(value.trim())) {
    throw new ConfigError('createPersonioGateway requires options.clientId. Embedded instances do not read credentials from the environment.');
  }
  return value.trim();
}

function requiredSecret(options: PersonioGatewayOptions): string {
  const value: unknown = (options as Partial<PersonioGatewayOptions> | undefined)?.clientSecret;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError('createPersonioGateway requires options.clientSecret. Embedded instances do not read credentials from the environment.');
  }
  // Key admission: printable ASCII of 16 characters or more, sharing no piece with any text of ours. The refusal is
  // a fixed text that holds no piece of the secret.
  if (!admitsKey(value.trim())) throw new ConfigError(keyRefusedText(value.trim()));
  return value.trim();
}

/**
 * Create one gateway instance for one Personio company. `clientId` and
 * `clientSecret` are required and are the only credentials it uses.
 */
export function createPersonioGateway(options: PersonioGatewayOptions) {
  const guard = new SecretRedactor();
  const givenSecret: unknown = (options as Partial<PersonioGatewayOptions> | undefined)?.clientSecret;
  const givenId: unknown = (options as Partial<PersonioGatewayOptions> | undefined)?.clientId;
  const secrets = [
    ...(typeof givenSecret === 'string' ? [givenSecret, givenSecret.trim()] : []),
    ...(typeof givenId === 'string' ? [givenId, givenId.trim()] : []),
  ];
  let admitted: string | undefined;
  const refusal = () => keyRefusedText(admitted ?? (typeof givenSecret === 'string' ? givenSecret : ''));
  try {
    const clientSecret = requiredSecret(options);
    admitted = clientSecret;
    guard.addSecret(clientSecret);
    const clientId = requiredClientId(options);
    if (clientId === clientSecret) throw new ConfigError('options.clientId and options.clientSecret must differ.');
    guard.addSecret(clientId);
    if (leaksSecret(fixedOutputs(), guard)) throw new ConfigError(refusal());
    const gateway = buildGateway(options, clientId, clientSecret);
    if (leaksSecret(gateway.tools, guard)) throw new ConfigError(refusal());
    return gateway;
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    let message = guard.redact(raw);
    if (leaksSecret(message, guard)) message = refusal();
    const final = sealedError(error instanceof ConfigError ? new ConfigError(message) : new Error(message), ...secrets);
    if (leaksSecret(final, guard)) throw sealedError(new ConfigError(refusal()), ...secrets);
    throw final;
  }
}

function buildGateway(options: PersonioGatewayOptions, clientId: string, clientSecret: string) {
  const policy = resolvePolicy(options.policy);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
    throw new ConfigError('options.timeoutMs must be an integer between 1 and 600000.');
  }
  const redactor = new SecretRedactor().addSecret(clientSecret).addSecret(clientId).addHeader('authorization');
  // Every option is given explicitly, so the client reads nothing from the environment. Every access token Personio
  // issues is a secret of this instance too: redacted from results, errors and audit records like the credentials.
  const client = new PersonioClient({
    onAccessToken: token => void redactor.addSecret(token),
    clientId,
    clientSecret,
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
    timeoutMs,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const tools = personioGatewayTools.filter(tool => !policy.disabledTools.has(tool.name));

  async function audit(record: Record<string, unknown>): Promise<void> {
    if (!policy.audit) return;
    const final = JSON.parse(JSON.stringify(redactDeep(record, redactor))) as Record<string, unknown>;
    await policy.audit(Object.freeze(leaksSecret(final, redactor) ? withheldAuditRecord() : final));
  }

  async function runCall(
    toolName: string,
    input: GatewayJsonObject,
    context: GatewayCallContext | undefined,
    actAs: Readonly<ActAs> | undefined,
  ): Promise<GatewayToolResult> {
    const tool = typeof toolName === 'string' ? findGatewayTool(toolName) : undefined;
    if (!tool) return errorResult('Unsupported Personio gateway tool.');
    if (policy.disabledTools.has(tool.name)) return errorResult(`The tool ${tool.name} is disabled on this instance by the embedding host.`);
    if (tool.risk === 'write' && !policy.enableWrites) {
      return errorResult(`The write tool ${tool.name} is disabled: the embedding host has not enabled writes for this instance.`);
    }
    // A self tool runs only for a person the host gave: never for the company, never for someone else.
    if (tool.self && !actAs) return actAsRefused('invalid');
    const parsed = tool.inputSchema.safeParse(input ?? {});
    if (!parsed.success) return errorResult(redactor.redact(`Invalid input for ${tool.name}: ${z.prettifyError(parsed.error)}`));
    const requestId = typeof context?.requestId === 'string' && /^[\x21-\x7e]{1,128}$/.test(context.requestId) ? context.requestId : undefined;
    const base = { tool: tool.name, risk: tool.risk, ...(requestId ? { requestId } : {}) };
    try {
      await audit({ timestamp: new Date().toISOString(), ...base, action: 'start' });
    } catch {
      // A write runs only if its start record was accepted.
      if (tool.risk === 'write') return errorResult('The audit record could not be written, so the change was not sent to Personio.');
    }
    try {
      // The person is found first, by the email only; a self tool gets the person id, never anything from the input.
      const self = tool.self && actAs ? await resolveSelf(client, actAs.email) : undefined;
      const data = await tool.run(client, parsed.data as Record<string, unknown>, self);
      await audit({ timestamp: new Date().toISOString(), ...base, action: 'finish' }).catch(() => undefined);
      return { content: [{ type: 'text', text: tool.summary }], structuredContent: (data ?? null) as GatewayJsonValue };
    } catch (error) {
      if (error instanceof ActAsRefusedError) {
        await audit({ timestamp: new Date().toISOString(), ...base, action: 'refused', reason: error.refusal }).catch(() => undefined);
        return actAsRefused(error.refusal);
      }
      const text = errorText(error, tool.risk === 'write');
      await audit({ timestamp: new Date().toISOString(), ...base, action: 'error', status: statusOf(error) ?? null }).catch(() => undefined);
      return errorResult(text, failureMetadata(error));
    }
  }

  return {
    /** Tools enabled on this instance (the policy's disabled tools are left out). */
    tools,
    callTool(toolName: string, input: GatewayJsonObject = {}, context?: GatewayCallContext): Promise<GatewayToolResult> {
      // The person to act as, checked before anything else: a malformed one refuses the call, so it never runs as
      // anyone else by mistake.
      let actAs: Readonly<ActAs> | undefined;
      try {
        actAs = normaliseActAs(context?.actAs);
      } catch {
        return Promise.resolve(actAsRefused('invalid'));
      }
      return runCall(toolName, input, context, actAs).then(result => {
        // Redacted as data, copied as JSON, the data also put in the text, then the sink check on the final form.
        // The failure metadata is checked again after redaction: an id that redaction changed is dropped.
        const final = withDataInText(
          withFailureInForm(
            JSON.parse(JSON.stringify(redactDeep(redactDeep(result, redactor), redactor))) as GatewayToolResult,
          ),
        );
        return leaksSecret(final, redactor) ? withheldResult() : final;
      });
    },
  };
}

/** One gateway instance, as returned by createPersonioGateway. */
export type PersonioGateway = ReturnType<typeof createPersonioGateway>;

const STATUS_HINTS: Record<number, string> = {
  400: 'Personio refused the input. Check the ids and dates.',
  401: 'Personio did not accept the API credentials.',
  403: 'The API credentials have no access to this in Personio.',
  404: 'Personio did not find it, or the API credentials have no access to it.',
  409: 'Personio refused the change because it conflicts with existing data.',
  422: 'Personio refused the input. Check the ids and dates.',
  429: 'Personio is throttling requests. Wait and retry later.',
};

function statusOf(error: unknown): number | undefined {
  return error instanceof PersonioHttpError && Number.isInteger(error.status) ? error.status : undefined;
}

/**
 * Our own text for a failed call: the HTTP status and a fixed hint, never
 * Personio's response body. A failed token request says so. For a write, a
 * failure without a 4xx answer may come after Personio made the change.
 */
export function errorText(error: unknown, write = false): string {
  if (error instanceof GatewayInputError) return error.message;
  const status = statusOf(error);
  if (status !== undefined && error instanceof PersonioHttpError && /\/v[12]\/auth(?:\/token)?$/.test(error.url)) {
    return `Personio refused the API credentials (HTTP ${status}).`;
  }
  if (status !== undefined) {
    const hint = Object.hasOwn(STATUS_HINTS, status) ? STATUS_HINTS[status] : undefined;
    const unsure = write && !(status >= 400 && status <= 499) ? ' The change may have been made; check in Personio.' : '';
    return `Personio API request failed with HTTP ${status}${hint ? ` | ${hint}` : ''}${unsure}`;
  }
  const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
  const unsure = write ? ' The change may have been made; check in Personio.' : '';
  return `${timedOut ? 'Personio API request timed out.' : 'Personio API request failed.'}${unsure}`;
}

function withDataInText(result: GatewayToolResult): GatewayToolResult {
  if (result.isError || result.structuredContent === undefined) return result;
  const [first, ...rest] = result.content;
  return {
    ...result,
    content: [{ type: 'text', text: `${first?.text ?? ''}\n\n${JSON.stringify(result.structuredContent)}` }, ...rest],
  };
}

/** A call not made as the person: our fixed text and the refusal, nothing else. */
function actAsRefused(refusal: ActAsRefusal): GatewayToolResult {
  return { ...errorResult(new ActAsRefusedError(refusal).message), actAsRefused: refusal };
}

function errorResult(text: string, failure?: GatewayFailure): GatewayToolResult {
  return { isError: true, content: [{ type: 'text', text }], ...(failure ? { failure } : {}) };
}

/**
 * The failure metadata as it must be after redaction: on an error result only, a status of 100-599 and a request id
 * still in the form of one (redaction can have changed it). Anything else is dropped, never passed on.
 */
function withFailureInForm(result: GatewayToolResult): GatewayToolResult {
  const { failure, actAsRefused: refusal, ...withoutRefusal } = result;
  // The refusal stays only on an error result, and only as one of ours.
  const kept = result.isError ? actAsRefusalInForm(refusal) : undefined;
  const rest: GatewayToolResult = kept ? { ...withoutRefusal, actAsRefused: kept } : withoutRefusal;
  if (!result.isError || failure === undefined || failure === null || typeof failure !== 'object') return rest;
  const status = failure.httpStatus;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) return rest;
  const requestId = vendorRequestId(failure.requestId);
  return { ...rest, failure: requestId === undefined ? { httpStatus: status } : { httpStatus: status, requestId } };
}
