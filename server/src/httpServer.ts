import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';

import { agentCreatedMessage } from './agentMessages.js';
import type { AgentRuntime } from './agentRuntime.js';
import type { AgentStateStore } from './agentStateStore.js';
import type {
  AssetCache,
  ReloadAssetsSideEffect,
  SetHooksEnabledSideEffect,
} from './clientMessageHandler.js';
import {
  CONTROL_MESSAGE_TYPES,
  handleClientMessage,
  terminalAvailabilityMessage,
} from './clientMessageHandler.js';
import {
  CONTROL_EXPIRY_CHECK_MS,
  HOOK_API_PREFIX,
  MAX_HOOK_BODY_SIZE,
  PERMISSION_DECISION_PATH,
  USAGE_API_PREFIX,
  WS_CLOSE_FORBIDDEN_ORIGIN,
  WS_CLOSE_UNAUTHORIZED,
} from './constants.js';
import { applyReportedContext } from './contextUsage.js';
import {
  auditControl,
  isLocalRequest,
  isPinSet,
  issueTicket,
  isTicketValid,
  revokeTicket,
  setControlSocket,
  touchTicket,
  verifyControlPin,
  watchTicket,
} from './controlPolicy.js';
import { permissionBrokerFor } from './permissionBroker.js';
import { PERMISSION_NONCE_HEADER, signDecision } from './permissionSignature.js';
import { hookProviderById } from './providers/index.js';
import { registerTerminalRoutes } from './terminal/terminalRoutes.js';
import type { TerminalSessions } from './terminal/terminalSessions.js';
import type { AgentState } from './types.js';
import {
  PRIVILEGED_BROADCAST_TYPES,
  recordUsageReport,
  usageLimitsMessage,
} from './usageLimits.js';
import { redactForViewer } from './viewerRedaction.js';
import {
  bearerTokenValid,
  isAllowedWebSocketOrigin,
  privilegedHostnames,
  redactTokenQuery,
  standaloneHandshakeVerdict,
} from './wsAuth.js';

/** Options for creating the HTTP + WebSocket server. */
export interface HttpServerOptions {
  /** true = VS Code embedded mode (ephemeral port, no static, quiet logging) */
  embedded: boolean;
  /** Host to bind to. Default: '127.0.0.1' */
  host?: string;
  /** Port to listen on. Default: 0 (auto-assign) */
  port?: number;
  /** Bearer auth token for hook and WebSocket endpoints */
  token: string;
  /** Signs permission decisions (see ServerConfig.decisionKey); absent = no decisions. */
  decisionKey?: string;
  /** AgentStateStore for WebSocket broadcast piping */
  store: AgentStateStore;
  /** Shared agent lifecycle core (for toggle side effects + standalone restore). Optional in embedded mode. */
  runtime?: AgentRuntime;
  /** Path to SPA dist directory for static serving (standalone only) */
  staticDir?: string;
  /** Cached assets loaded at startup (standalone only) */
  assetCache?: AssetCache;
  /** Callback when a hook event is received */
  onHookEvent?: (providerId: string, event: Record<string, unknown>) => void;
  /** Invoked when setHooksEnabled is toggled via WebSocket. Standalone installs/uninstalls hooks here. */
  onSetHooksEnabled?: SetHooksEnabledSideEffect;
  /** Invoked when an external asset directory is added/removed. Standalone reloads + re-broadcasts assets here. */
  onReloadAssets?: ReloadAssetsSideEffect;
  /** PTY terminals for standalone-launched agents. Absent = terminal feature off
   *  (VS Code embedded mode, where the editor owns terminals). */
  ptyManager?: TerminalSessions;
  /** The package root holding dist/hooks/ (standalone), from which the Usage
   *  Bars toggle installs the status line bridge script. */
  packageRoot?: string;
  /** Extra Host names (beyond loopback and a specific bind address) a
   *  privileged standalone handshake may arrive under -- e.g. a reverse proxy's
   *  public name. See wsAuth.privilegedHostnames. */
  allowedHosts?: readonly string[];
}

/** Result of createHttpServer(). */
export interface HttpServerHandle {
  app: FastifyInstance;
  port: number;
}

const startTime = Date.now();

/**
 * Create a Fastify server with hook endpoint, health check, and WebSocket support.
 *
 * All Fastify-specific code lives in this file. The rest of the server layer is
 * framework-agnostic. If Fastify is ever replaced, only this file changes.
 */
export async function createHttpServer(options: HttpServerOptions): Promise<HttpServerHandle> {
  const app = Fastify({
    // Standalone logs every request. The privilege token rides `/ws?token=`
    // and `/terminal/:id?token=` handshakes, so the url is redacted before it
    // is written -- otherwise every (re)connect would put the secret in stdout
    // and any log file (see wsAuth.redactTokenQuery).
    logger: options.embedded ? false : { serializers: { req: serializeRequestForLog } },
    bodyLimit: MAX_HOOK_BODY_SIZE,
  });

  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyWebsocket);

  // Static SPA serving (standalone mode only)
  if (!options.embedded && options.staticDir) {
    await app.register(fastifyStatic, {
      root: options.staticDir,
      prefix: '/',
    });
    // HTML5 history fallback: serve index.html for unmatched routes
    app.setNotFoundHandler((_req, reply) => {
      reply.sendFile('index.html');
    });
  }

  // ── Routes ──────────────────────────────────────────────────

  const host = options.host ?? '127.0.0.1';
  const allowedHostnames = privilegedHostnames(host, options.allowedHosts ?? []);

  registerHealthRoute(app);
  registerHookRoute(app, options);
  registerPermissionRoute(app, options);
  registerUsageRoute(app, options);
  registerWebSocketRoute(app, options, allowedHostnames);
  registerTerminalRoutes(app, {
    token: options.token,
    allowedHostnames,
    ptyManager: options.ptyManager,
  });

  // ── Listen ──────────────────────────────────────────────────

  await app.listen({ host, port: options.port ?? 0 });
  const address = app.server.address();
  const port = typeof address === 'object' ? (address?.port ?? 0) : 0;

  return { app, port };
}

// ── Health ──────────────────────────────────────────────────────

function registerHealthRoute(app: FastifyInstance): void {
  app.get('/api/health', async () => ({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    pid: process.pid,
  }));
}

// ── Hook Events ────────────────────────────────────────────────

/**
 * A PermissionRequest hook asking for a browser decision: processed like any
 * hook event (the office shows the request), then held by the permission
 * broker until answered, moved past, withdrawn or timed out. Replies
 * `{decision: 'allow'|'deny'|null}`; null leaves the terminal prompt in charge.
 */
function registerPermissionRoute(app: FastifyInstance, options: HttpServerOptions): void {
  app.post<{
    Params: { providerId: string };
    Body: Record<string, unknown>;
  }>(
    `${HOOK_API_PREFIX}/:providerId/${PERMISSION_DECISION_PATH}`,
    {
      preHandler: bearerAuth(options.token),
      schema: {
        params: {
          type: 'object',
          properties: { providerId: { type: 'string', pattern: '^[a-z0-9-]+$' } },
          required: ['providerId'],
        },
      },
    },
    async (request, reply) => {
      const { providerId } = request.params;
      const event = request.body;
      if (!event.session_id || !event.hook_event_name) return { decision: null };
      options.onHookEvent?.(providerId, event);
      const broker = permissionBrokerFor(options.store);
      if (!broker || providerId !== 'claude') return { decision: null };
      // The hook proves the answer came from this server: no nonce, no decision.
      const nonce = request.headers[PERMISSION_NONCE_HEADER];
      if (typeof nonce !== 'string' || nonce.length < 16 || !options.decisionKey) {
        return { decision: null };
      }
      const decisionKey = options.decisionKey;
      const decision = await broker.ask(event, (onAbort) => {
        reply.raw.on('close', () => {
          if (!reply.raw.writableFinished) onAbort();
        });
      });
      return {
        decision,
        signature: decision ? signDecision(decisionKey, nonce, decision) : undefined,
      };
    },
  );
}

function registerHookRoute(app: FastifyInstance, options: HttpServerOptions): void {
  app.post<{
    Params: { providerId: string };
    Body: Record<string, unknown>;
  }>(
    `${HOOK_API_PREFIX}/:providerId`,
    {
      preHandler: bearerAuth(options.token),
      schema: {
        params: {
          type: 'object',
          properties: {
            providerId: { type: 'string', pattern: '^[a-z0-9-]+$' },
          },
          required: ['providerId'],
        },
      },
    },
    async (request, reply) => {
      const { providerId } = request.params;
      const event = request.body;

      if (event.session_id && event.hook_event_name) {
        options.onHookEvent?.(providerId, event);
        // A session that moved on answered any held permission prompt itself.
        permissionBrokerFor(options.store)?.observe(event);
      }

      reply.send('ok');
    },
  );
}

// ── Usage reports ──────────────────────────────────────────────

/** A provider's usage bridge reports the account's plan limits here. Stored,
 *  and passed on to the office when they moved (recordUsageReport). */
function registerUsageRoute(app: FastifyInstance, options: HttpServerOptions): void {
  app.post<{ Params: { providerId: string }; Body: unknown }>(
    `${USAGE_API_PREFIX}/:providerId`,
    {
      preHandler: bearerAuth(options.token),
      schema: {
        params: {
          type: 'object',
          properties: { providerId: { type: 'string', pattern: '^[a-z0-9-]+$' } },
          required: ['providerId'],
        },
      },
    },
    async (request, reply) => {
      const provider = hookProviderById(request.params.providerId);
      if (provider && recordUsageReport(provider, request.body)) {
        options.store.broadcast({ ...usageLimitsMessage(provider.id) });
      }
      const context = provider?.usageBridge?.normalizeContext(request.body);
      if (context) applyReportedContext(options.store, context);
      reply.send('ok');
    },
  );
}

// ── WebSocket ──────────────────────────────────────────────────

function registerWebSocketRoute(
  app: FastifyInstance,
  options: HttpServerOptions,
  allowedHostnames: ReadonlySet<string>,
): void {
  app.get('/ws', { websocket: true }, (socket, request) => {
    // CONNECTION gate. Embedded (VS Code) requires the Bearer token. Standalone
    // requires a same-origin handshake instead (isAllowedWebSocketOrigin), so a
    // non-browser local client with no Origin can still watch the office. What
    // may be DONE over an accepted connection is a separate question, decided
    // below.
    if (options.embedded) {
      if (!bearerTokenValid(request.headers.authorization, options.token)) {
        socket.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
        return;
      }
    } else if (!isAllowedWebSocketOrigin(request.headers.origin, request.headers.host)) {
      socket.close(WS_CLOSE_FORBIDDEN_ORIGIN, 'forbidden origin');
      return;
    }

    // Both modes prove privilege with the SAME out-of-band secret, differently
    // carried: embedded sends the Bearer token it was handed in-process;
    // standalone sends the `?token=` the CLI printed in the local URL and the
    // SPA forwarded on this handshake, and it must arrive under an allowed Host
    // -- the same verdict the terminal socket applies. A network POSITION
    // never grants privilege, because every position is reproducible by a
    // forwarder; the Host allowlist can only take it away.
    let privileged = options.embedded;
    if (!options.embedded) {
      const verdict = standaloneHandshakeVerdict(
        request.url,
        request.headers.host,
        options.token,
        allowedHostnames,
      );
      privileged = verdict === 'privileged';
      if (verdict === 'untrusted-host') {
        // The operator has the right URL but reached us under a name they never
        // listed (typically a reverse proxy). Say how to fix it, or the session
        // silently stays watch-only.
        console.warn(
          `[Pixel Agents] Tokened connection via Host "${request.headers.host ?? ''}" is read-only: restart with --allowed-host <that name> to allow changes from it.`,
        );
      }
    }

    const { store } = options;

    // Control (answering permissions, launching, typing) is a tier above
    // privilege: a tokened socket from this machine controls with the token
    // alone; any other tokened socket must unlock with the control PIN, and its
    // unlock lapses after an idle period (controlPolicy.ts).
    const local = isLocalRequest(request.socket.remoteAddress, request.headers);
    let control = privileged && local;
    let ticket: string | undefined;
    let unlockError: string | undefined;
    let lockedUntil: number | undefined;
    const sendControlAccess = () => {
      setControlSocket(socket, control);
      // Terminals follow control: unlocking (or locking) opens (or closes) them here.
      if (options.ptyManager && !options.embedded) {
        send(terminalAvailabilityMessage(options.ptyManager, privileged, control));
      }
      send({
        type: 'controlAccess',
        control,
        local,
        pinSet: isPinSet(),
        ticket,
        error: unlockError,
        lockedUntil,
      });
    };
    const clientKind = local ? 'local' : 'remote';
    /** Control right now, without counting as use: a remote unlock lasts while
     *  its ticket is valid, so a lapsed one stops at once, not on the next message. */
    const controlNow = () => control && (local || isTicketValid(ticket));
    let unwatchTicket: (() => void) | undefined;
    /** A remote unlock ended (Lock, a new PIN, idle expiry): drop control here. */
    const lapse = () => {
      unwatchTicket?.();
      unwatchTicket = undefined;
      if (!control || local) return;
      control = false;
      ticket = undefined;
      sendControlAccess();
    };
    // Idle expiry has no event of its own; check for it now and then.
    const expiryTimer = setInterval(() => {
      if (control && !local && !isTicketValid(ticket)) lapse();
    }, CONTROL_EXPIRY_CHECK_MS);
    /** For a control action: valid, and counts as use (sliding idle expiry).
     *  Other messages never extend an unlock. */
    const useControl = () => {
      if (!control || local) return control;
      if (touchTicket(ticket)) return true;
      lapse();
      return false;
    };
    // Every message to this socket goes through here: read-only viewers get
    // tool activity as broad categories, never file names or commands.
    const send = (message: Record<string, unknown>) => {
      // The full request behind an approval is for connections that may answer it.
      if (message.type === 'agentPermissionPending' && !controlNow() && 'detail' in message) {
        const { detail: _detail, ...rest } = message;
        message = rest;
      }
      safeSend(socket, privileged ? message : redactForViewer(message));
    };

    // Pipe store events to WebSocket client
    const onAgentAdded = (id: number, agent: AgentState) => {
      send(agentCreatedMessage(id, agent));
    };

    const onAgentRemoved = (id: number) => {
      send({ type: 'agentClosed', id });
    };

    const onBroadcast = (message: Record<string, unknown>) => {
      // The operator's account usage is not for read-only viewers.
      if (!privileged && PRIVILEGED_BROADCAST_TYPES.has(String(message.type))) return;
      send(message);
    };

    store.on('agentAdded', onAgentAdded);
    store.on('agentRemoved', onAgentRemoved);
    store.on('broadcast', onBroadcast);
    if (!options.embedded) sendControlAccess();

    // Handle incoming client messages
    socket.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (!options.embedded && msg.type) {
          console.log('[Pixel Agents] WS client message:', msg.type);
        }
        if (!options.embedded && privileged && msg.type === 'unlockControl') {
          if (local) {
            control = true;
          } else {
            const verdict = verifyControlPin(msg.pin, request.socket.remoteAddress ?? '');
            unlockError = verdict.ok ? undefined : verdict.reason;
            lockedUntil = verdict.ok ? undefined : verdict.lockedUntil;
            if (verdict.ok) {
              // A fresh unlock replaces this socket's old one, never adds to it.
              unwatchTicket?.();
              revokeTicket(ticket);
              ticket = issueTicket();
              control = true;
              unwatchTicket = watchTicket(ticket, lapse);
            }
            auditControl({
              action: 'unlock',
              client: clientKind,
              outcome: verdict.ok ? 'ok' : verdict.reason,
            });
          }
          sendControlAccess();
          return;
        }
        if (!options.embedded && msg.type === 'lockControl') {
          if (!local) {
            unwatchTicket?.();
            unwatchTicket = undefined;
            revokeTicket(ticket);
            ticket = undefined;
            control = false;
          }
          sendControlAccess();
          return;
        }
        handleClientMessage(msg, send, {
          store,
          runtime: options.runtime,
          cache: options.assetCache ?? null,
          onSetHooksEnabled: options.onSetHooksEnabled,
          onReloadAssets: options.onReloadAssets,
          packageRoot: options.packageRoot,
          privileged,
          // Embedded (VS Code) keeps upstream behavior: the editor is local.
          control: options.embedded
            ? privileged
            : privileged &&
              (CONTROL_MESSAGE_TYPES.has(String(msg.type)) ? useControl() : controlNow()),
          local,
          ptyManager: options.ptyManager,
        });
      } catch {
        // Malformed JSON, ignore
      }
    });

    socket.on('close', () => {
      clearInterval(expiryTimer);
      unwatchTicket?.();
      // The unlock belongs to this page; its terminals end with it.
      if (!local) revokeTicket(ticket);
      setControlSocket(socket, false);
      store.off('agentAdded', onAgentAdded);
      store.off('agentRemoved', onAgentRemoved);
      store.off('broadcast', onBroadcast);
    });
  });
}

// ── Auth Helper ────────────────────────────────────────────────

function bearerAuth(expectedToken: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!bearerTokenValid(request.headers.authorization, expectedToken)) {
      reply.code(401).send('unauthorized');
    }
  };
}

// ── Logging ────────────────────────────────────────────────────

/** Fastify's default request serializer, minus the token query. Exported so a
 *  test can pin that the secret never reaches the log line. */
export function serializeRequestForLog(request: FastifyRequest): Record<string, unknown> {
  return {
    method: request.method,
    url: redactTokenQuery(request.url),
    hostname: request.hostname,
    remoteAddress: request.ip,
    remotePort: request.socket.remotePort,
  };
}

// ── Utilities ──────────────────────────────────────────────────

function safeSend(
  socket: { send: (data: string) => void; readyState: number },
  message: Record<string, unknown>,
): void {
  // WebSocket.OPEN = 1
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(message));
  }
}
