import { handleDocumentAudience } from "./routes/document-audience";
// The PidginCore router: every route that the shared engine serves, in the order that it matches them.
// An edition adds its own routes and pages through the route blocks of core/edition-routes.ts, each
// at a fixed point so that the order stays the same, and its own behaviour through the hooks of
// core/edition-hooks.ts. A deployment's request pipeline (gates, metering, the request log) wraps
// this router from outside.

import { basePath, prefixBasePath, stripBasePath } from "./base-path";
import { editionRoutes, HOURLY_CRON, WORKSPACE_BACKUP_CRON } from "./edition-routes";
import { secureCookie } from "./cookies";
import { TenantWriteRefused, editionAccountActiveSql, editionMeterRequest, editionBlocksRequest, editionAccountSections, editionBrand, editionDocumentAudienceEnabled, editionErrorResponse, editionLoginPage, editionProductName, editionPublicSite, editionReaderLabels, editionSelectedSpace, editionShell } from "./edition-hooks";
import { messageReadSql } from "./workspace-access";
import { Env, EnhanceJob } from "./types";
import { corsHeaders, json } from "./utils";
import { logEventName } from "./wire-names";
import { handlePostMessage, handleGetMessages, handleGetMessage, handleGetMessageContext, handleGetReplies, handleMarkMessageRead, handleMarkAllRead, handleDeleteMessage, handleUpdatePriority, handleArchiveMessage, handleUnarchiveMessage, handleBulkArchive, handleDismissMessage, handlePinMessage } from "./routes/messages";
import { scheduled } from "./cron";
import { runScheduledWorkspaceBackup } from "./workspace-backup-scheduled";
import { runGovernedContentCleanup } from "./governed-content-cleanup";
import { handleDeferredActions, handleEventTicket, handleEventsWebSocket, handleInbox, handleListEvents, handleWaitForEvents } from "./routes/events";
import { listInboxItems } from "./events/query";
import { recheckEventStreams, streamsOfUser } from "./events/live";
import { handleEnhanceQueueBatch } from "./enhance/consumer";
import { handleGetDoc, handleGetInteractiveDoc, handleShareDoc, handleDocLog, handlePreviewDoc, handlePreviewImage, handleGetDocVersions } from "./routes/docs";
import { handlePublishArtifact, handleListArtifacts, handleGetArtifactMeta, handlePatchArtifact, handleDeleteArtifact, handleShareArtifact, handleServeArtifact, artifactAssetResponse, handleArtifactRuntimeComplete, handleArtifactRuntimeStorage, handleArtifactTelemetry } from "./routes/artifacts";
import { handleGetClientBuild, handlePostClientBuild } from "./routes/client-build";
import { handlePostReply } from "./routes/reply";
import { handleRegister, handleGetRegistry, handleDeregister, handleHeartbeat, handleGetInstance } from "./routes/registry";
import { ensureOwnerExists, findActiveUserByEmail } from "./auth-utils";
import { handleLogin, handleVerify, handleRegisterDevice, handleAppleAppSiteAssociation, handleInviteUser, handleAcceptInvite, handleOAuthLoginWeb } from "./routes/auth";
import { handleOAuthLogin } from "./auth/oauth-login";
import { handleLinkIdentity, handleListIdentities, handleUnlinkIdentity } from "./routes/identities";
import { handleGetProfile, handleRevokeDevice } from "./routes/profile";
import { handleNotify, handleProviders } from "./routes/notify";
import { handleGetCommuteAudio, handleGetCommuteBriefings, handleGetCommuteTranscript, handleGetLatestCommute, handleOpenLatestCommute } from "./routes/commute";
import { handleAddToPlaylist, handleClearPlaylist, handleGeneratePlaylistBriefing, handleGetCommuteSource, handleGetPlaylist, handleRemoveFromPlaylist, handleSetCommuteSource, handleSetPlaylist } from "./routes/playlist";
import { handleMcp } from "./routes/mcp";
import { handleHelpApi } from "./routes/help";
import { handleCloseConversation, handleCreateConversation, handleGChatConfig, handleGChatEvents, handleGetConversationMessages, handleListConversations, handleMatrixConfig, handlePostConversationMessage } from "./routes/chat";
import { handleCreateComment, handleCreateDecisionMemo, handleCreateProject, handleUpdateProject, handleWorkspaceTags, handleSetResourceTags, handleCreateTeam, handleListComments, handleListDecisionMemos, handleListWorkspaceBackups, handleListProjects, handleListTeams, handleWorkspaceFeed, handleWorkspaceOverview, handleCreateWorkspacePost, handleWorkspaceMembers, handleShareWorkspaceResource, handleSetResourceSharing } from "./routes/workspace";
import { handleProjectManagementPolicy } from "./routes/project-management-policy";
import { handleCommitDraft, handleDeleteDraft, handlePutDraft } from "./routes/drafts";
import { handleBatch, runBatchSweep } from "./routes/batch";
import { DRAFT_CRON, runDraftSweep } from "./drafts";
import { handleGetBoardInlineUsage, handleGetAgentBoardDocument, handleBulletinPostAction, handleCloseWorkBoard, handleCloseWorkspaceWorkBoard, handleCreateWorkBoard, handleCreateWorkspaceAgent, handleGetAgentBoard, handleJoinWorkBoard, handleListAgentBoards, handleListWorkspaceAgents, handlePostAgentBoard, handleRevokeWorkspaceAgent, handleTombstoneAgentBoardEntry } from "./routes/agent-board";
import { handleRcCommand, handleRcPoll, handleRcSubmitResult, handleRcGetResult, handleRcStatus } from "./routes/rc";
import { handleOAuthAuthorizationServerMetadata, handleOAuthAuthorize, handleOAuthProtectedResourceMetadata, handleOAuthRegister, handleOAuthToken } from "./routes/oauth";
import { handleDeviceLoginStart, handleDeviceLoginPage, handleDeviceLoginDecision, handleDeviceLoginPoll, handleNativeDeviceLoginInspect, handleNativeDeviceLoginDecision } from "./routes/device-login";
import { handlePostPreview, handleGetPreview } from "./routes/preview";
import { handlePostEmail } from "./routes/email";
import { handleSetupApi, handleSetupForm, canEditSetup } from "./routes/setup";
import { handleApiKeysCreate, handleApiKeysList, handleApiKeysRevoke, createKeyForUser, listKeysForUser, revokeKeyForUser } from "./routes/keys";
import { handleAdminUsers, handleAdminUser, handleAdminMessages, handleAdminStats, handleAdminSuspend, handleAdminSql, handleAdminInvite } from "./routes/admin";
import { handleDeleteDesignSystem, handleGetDesignSystem, handleImportDesignSystem, handleListDesignSystems, handlePutDesignSystem } from "./routes/design-systems";
import { withNavShell, type NavShellOptions } from "./web/nav-shell";
import { theme } from "./web/theme";
import { inboxPage, registryPage, setupPage, statsPage, tocPage } from "./web/index";
import { handleListHandoffs, handleSetHandoffArchive, handleSetHandoffRead } from "./routes/handoffs";
import { handleFavorites } from "./routes/favorites";
import { handleNotes } from "./routes/notes";
import { loadMessageBlocks } from "./messages/store";
import { verifySession, verifyOwnerCredential, unauthorized, resolveApiKeyUser, resolveCallerUserId, resolveSessionUserId } from "./middleware";
import { handleAudioStream, handleAudioTranscript, handleDeleteAudio, handleGetAudio, handleListAudio, handlePatchAudio, handlePostAudio } from "./routes/audio";
import { canAdminWorkspace, listTeams } from "./workspace";
import { getSetupStatus } from "./setup/status";
import { createInviteCode } from "./invites";
import { handleOwnerUsers, handleOwnerInviteCode } from "./routes/owner-admin";
import { handleLibrary } from "./library";

export const coreRouter = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const base = basePath(env);
    const routeContext = { request, env, ctx, url, path, method, base };
    // People shows in the account menu for workspace admins; teams are passed in when the handler already has them.
    const canManagePeopleFor = async (userId: string, teams?: Awaited<ReturnType<typeof listTeams>>): Promise<boolean> =>
      canAdminWorkspace((await editionSelectedSpace(request, userId, teams ?? await listTeams(env, userId)))?.role);
    const shellFor = (userId: string): NavShellOptions => ({ accent: theme.primary, publicSite: editionPublicSite(env), userId, base, commands: editionRoutes().navigation });

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      // An edition refuses the paths of features it does not have.
      if (editionBlocksRequest(env, method, path)) {
        return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
      }
      // The private Library (pages, API) when the deployment has it; a deployment without it falls through to 404.
      { const routed = await handleLibrary(request, env, path); if (routed) return routed; }
      { const routed = await editionRoutes().controlFirst?.(routeContext); if (routed) return routed; }
      { const routed = await editionRoutes().hostingFirst?.(routeContext); if (routed) return routed; }
      { const routed = await editionRoutes().teamsTranslation?.(routeContext); if (routed) return routed; }
      { const routed = await editionRoutes().hostingPublic?.(routeContext); if (routed) return routed; }

      { const routed = await editionRoutes().controlBeforeOwner?.(routeContext); if (routed) return routed; }
      { const routed = await editionRoutes().hostingBeforeOwner?.(routeContext); if (routed) return routed; }
      await ensureOwnerExists(env);

      { const routed = await editionRoutes().controlOnboarding?.(routeContext); if (routed) return routed; }
      { const routed = await editionRoutes().hostingManaged?.(routeContext); if (routed) return routed; }

      { const routed = await editionRoutes().controlPublic?.(routeContext); if (routed) return routed; }
      { const routed = await editionRoutes().teamAdministration?.(routeContext); if (routed) return routed; }
      { const routed = await editionRoutes().hostingAccounts?.(routeContext); if (routed) return routed; }

      { const routed = await editionRoutes().teamsSignIn?.(routeContext); if (routed) return routed; }
      { const routed = await editionRoutes().hostingIdentity?.(routeContext); if (routed) return routed; }

      // Health
      if (path === "/health" && method === "GET") {
        return json({ ok: true, data: { status: "healthy" } });
      }

      // Public status — no auth, lightweight readiness check for agents
      if (path === "/api/status" && method === "GET") {
        const userId = await resolveCallerUserId(request, env);
        const baseStatus = {
          status: "healthy",
          environment: env.ENVIRONMENT,
          apns_configured: Boolean(env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_PRIVATE_KEY),
        };
        if (userId) {
          const [msgCount, urgentCount, unreadCount, instanceCount, liveInstanceCount] = await Promise.all([
            env.DB.prepare(`SELECT COUNT(*) as count FROM messages WHERE team_id IS NULL AND ${messageReadSql("messages")}`).bind(userId, userId).first<{ count: number }>(),
            env.DB.prepare(`SELECT COUNT(*) as count FROM messages WHERE team_id IS NULL AND ${messageReadSql("messages")} AND priority = 'urgent' AND read = 0`).bind(userId, userId).first<{ count: number }>(),
            env.DB.prepare(`SELECT COUNT(*) as count FROM messages WHERE team_id IS NULL AND ${messageReadSql("messages")} AND read = 0`).bind(userId, userId).first<{ count: number }>(),
            env.DB.prepare("SELECT COUNT(*) as count FROM instances WHERE user_id = ?").bind(userId).first<{ count: number }>(),
            env.DB.prepare(`SELECT COUNT(*) as count FROM instances WHERE user_id = ? AND last_heartbeat > datetime('now', '-5 minutes')`).bind(userId).first<{ count: number }>(),
          ]);
          return json({
            ok: true,
            data: {
              ...baseStatus,
              message_count: msgCount?.count ?? 0,
              unread_count: unreadCount?.count ?? 0,
              urgent_unread: urgentCount?.count ?? 0,
              instance_count: instanceCount?.count ?? 0,
              live_instance_count: liveInstanceCount?.count ?? 0,
            },
          });
        }
        return json({ ok: true, data: baseStatus });
      }

      // Apple App Site Association — enables iOS universal links for magic-link auth
      if (path === "/.well-known/apple-app-site-association" && method === "GET") {
        return await handleAppleAppSiteAssociation(env);
      }

      // Notify (Stop hook + external providers)
      if (path === "/api/notify" && method === "POST") {
        return await handleNotify(request, env);
      }
      if (path === "/api/providers" && method === "GET") {
        return await handleProviders(request, env);
      }

      if (path.startsWith("/api/help/")) return await handleHelpApi(request, env);
      if (path === "/api/workspace/feed" && method === "GET") return await handleWorkspaceFeed(request, env);
      if (path === "/api/workspace/overview" && method === "GET") return await handleWorkspaceOverview(request, env);
      { const routed = await editionRoutes().teamsApi?.(routeContext); if (routed) return routed; }
      if (path === "/api/favorites" || path.startsWith("/api/favorites/")) return await handleFavorites(request, env);
      if (path === "/api/notes" || path.startsWith("/api/notes/")) return await handleNotes(request, env);
      if (path === "/api/events" && method === "GET") return await handleListEvents(request, env);
      if (path === "/api/events/ticket" && method === "POST") return await handleEventTicket(request, env);
      if (path === "/api/events/ws" && method === "GET") return await handleEventsWebSocket(request, env);
      if (path === "/api/events/wait" && method === "POST") return await handleWaitForEvents(request, env);
      if (path === "/api/deferred-actions" || path.startsWith("/api/deferred-actions/")) return await handleDeferredActions(request, env);
      if (path === "/api/inbox" || path.startsWith("/api/inbox/")) return await handleInbox(request, env);
      if (path === "/api/workspace/posts" && method === "POST") return await handleCreateWorkspacePost(request, env);
      if (path === "/api/sharing" && method === "POST") return await handleSetResourceSharing(request, env);
      if (path === "/api/workspace/share" && method === "POST") return await handleShareWorkspaceResource(request, env);
      const teamMembersMatch = path.match(/^\/api\/(?:workspace\/)?teams\/([a-zA-Z0-9-]+)\/members(?:\/([a-zA-Z0-9-]+))?$/);
      if (teamMembersMatch && ["GET", "PUT", "DELETE"].includes(method)) {
        return await handleWorkspaceMembers(request, env, teamMembersMatch[1], teamMembersMatch[2]);
      }
      if ((path === "/api/workspace/teams" || path === "/api/teams") && method === "GET") {
        return await handleListTeams(request, env);
      }
      if ((path === "/api/workspace/teams" || path === "/api/teams") && method === "POST") {
        return await handleCreateTeam(request, env);
      }
      if ((path === "/api/workspace/projects" || path === "/api/projects") && method === "GET") {
        return await handleListProjects(request, env);
      }
      if ((path === "/api/workspace/projects" || path === "/api/projects") && method === "POST") {
        return await handleCreateProject(request, env);
      }
      { const routed = await editionRoutes().teamsProjects?.(routeContext); if (routed) return routed; }
      const policyApiMatch = path.match(/^\/api\/projects\/([a-f0-9]+)\/management-policy$/);
      if (policyApiMatch && ["GET", "PUT"].includes(method)) {
        return await handleProjectManagementPolicy(request, env, policyApiMatch[1]);
      }
      const projectMatch = path.match(/^\/api\/(?:workspace\/)?projects\/([a-zA-Z0-9-]+)$/);
      if (projectMatch && method === "PATCH") return await handleUpdateProject(request, env, projectMatch[1]);
      if (path === "/api/workspace/tags" && ["GET", "POST"].includes(method)) return await handleWorkspaceTags(request, env);
      if (path === "/api/workspace/resource-tags" && method === "PUT") return await handleSetResourceTags(request, env);
      if ((path === "/api/workspace/comments" || path === "/api/comments") && method === "GET") {
        return await handleListComments(request, env);
      }
      if ((path === "/api/workspace/comments" || path === "/api/comments") && method === "POST") {
        return await handleCreateComment(request, env);
      }
      if (path === "/api/workspace/memos" && method === "GET") {
        return await handleListDecisionMemos(request, env);
      }
      if (path === "/api/workspace/handoffs" && method === "GET") {
        return await handleListHandoffs(request, env);
      }
      const handoffReadMatch = path.match(/^\/api\/workspace\/handoffs\/([a-f0-9]+)\/read$/);
      if (handoffReadMatch && method === "PATCH") {
        return await handleSetHandoffRead(request, env, handoffReadMatch[1]);
      }
      const handoffArchiveMatch = path.match(/^\/api\/workspace\/handoffs\/([a-f0-9]+)\/archive$/);
      if (handoffArchiveMatch && method === "PATCH") {
        return await handleSetHandoffArchive(request, env, handoffArchiveMatch[1]);
      }
      if (path === "/api/workspace/memos" && method === "POST") {
        return await handleCreateDecisionMemo(request, env);
      }
      if (path === "/api/workspace/backups" && method === "GET") {
        if (editionPublicSite(env)) return json({ ok: false, error: "Team backups are not available yet." }, 404);
        return await handleListWorkspaceBackups(request, env);
      }
      { const routed = await editionRoutes().teamsWorkspaceApi?.(routeContext); if (routed) return routed; }
      if (path === "/api/workspace/agents" && method === "GET") {
        return await handleListWorkspaceAgents(request, env);
      }
      if (path === "/api/workspace/agents" && method === "POST") {
        return await handleCreateWorkspaceAgent(request, env);
      }
      const workspaceAgentMatch = path.match(/^\/api\/workspace\/agents\/([a-f0-9]+)$/);
      if (workspaceAgentMatch && method === "DELETE") {
        return await handleRevokeWorkspaceAgent(request, env, workspaceAgentMatch[1]);
      }
      const boardModerationMatch = path.match(
        /^\/api\/workspace\/agent-board\/([a-f0-9]+)\/tombstone$/
      );
      if (boardModerationMatch && method === "POST") {
        return await handleTombstoneAgentBoardEntry(request, env, boardModerationMatch[1]);
      }
      const workspaceWorkBoardMatch = path.match(/^\/api\/workspace\/work-boards\/([a-f0-9]+)\/close$/);
      if (workspaceWorkBoardMatch && method === "POST") {
        return await handleCloseWorkspaceWorkBoard(request, env, workspaceWorkBoardMatch[1]);
      }
      const boardDocumentMatch = path.match(/^\/api\/agent-board\/([^/]+)\/documents\/([^/]+)$/);
      if (boardDocumentMatch && method === "GET") return await handleGetAgentBoardDocument(request, env, boardDocumentMatch[1], boardDocumentMatch[2]);
      if (path === "/api/agent-board/inline-usage" && method === "GET") return await handleGetBoardInlineUsage(request, env);
      if (path === "/api/agent-board/boards" && method === "GET") return await handleListAgentBoards(request, env);
      if (path === "/api/agent-board/work-boards" && method === "POST") return await handleCreateWorkBoard(request, env);
      const workBoardActionMatch = path.match(/^\/api\/agent-board\/work-boards\/([a-f0-9]+)\/(join|close)$/);
      if (workBoardActionMatch && method === "POST") {
        return workBoardActionMatch[2] === "join"
          ? await handleJoinWorkBoard(request, env, workBoardActionMatch[1])
          : await handleCloseWorkBoard(request, env, workBoardActionMatch[1]);
      }
      const bulletinPostMatch = path.match(/^\/api\/agent-board\/([a-f0-9]+)\/posts\/([1-9][0-9]{0,15})\/(close|read)$/);
      if (bulletinPostMatch && (method === "POST" || (method === "DELETE" && bulletinPostMatch[3] === "close"))) {
        return await handleBulletinPostAction(request, env, bulletinPostMatch[1], bulletinPostMatch[2], bulletinPostMatch[3] as "close" | "read", method);
      }
      const agentBoardMatch = path.match(/^\/api\/agent-board\/([a-f0-9]+)$/);
      if (agentBoardMatch && method === "GET") {
        return await handleGetAgentBoard(request, env, agentBoardMatch[1]);
      }
      if (agentBoardMatch && method === "POST") {
        return await handlePostAgentBoard(request, env, agentBoardMatch[1], ctx);
      }

      if (
        (path === "/.well-known/oauth-protected-resource" ||
          path === "/.well-known/oauth-protected-resource/mcp") &&
        method === "GET"
      ) {
        return await handleOAuthProtectedResourceMetadata(request, env);
      }
      if (path === "/.well-known/oauth-authorization-server" && method === "GET") {
        return await handleOAuthAuthorizationServerMetadata(request, env);
      }
      if (path === "/oauth/register" && method === "POST") {
        return await handleOAuthRegister(request, env);
      }
      if (path === "/oauth/authorize" && (method === "GET" || method === "POST")) {
        return await handleOAuthAuthorize(request, env);
      }
      if (path === "/oauth/token" && method === "POST") {
        return await handleOAuthToken(request, env);
      }
      if (path === "/auth/device/start" && method === "POST") return await handleDeviceLoginStart(request, env);
      if (path === "/auth/device" && method === "GET") return await handleDeviceLoginPage(request, env);
      if (path === "/auth/device" && method === "POST") return await handleDeviceLoginDecision(request, env);
      if (path === "/auth/device/token" && method === "POST") return await handleDeviceLoginPoll(request, env);
      if (path === "/auth/device/inspect" && method === "POST") return await handleNativeDeviceLoginInspect(request, env);
      if (path === "/auth/device/decision" && method === "POST") return await handleNativeDeviceLoginDecision(request, env);

      // MCP connector surface
      if (path === "/mcp" && (method === "POST" || method === "DELETE")) {
        return await handleMcp(request, env, ctx);
      }
      // Streamable HTTP: a client may open a GET event stream; this server offers none, and the spec answer is 405.
      if (path === "/mcp" && method === "GET") {
        return new Response(JSON.stringify({ ok: false, error: "method not allowed" }), {
          status: 405, headers: { "Content-Type": "application/json", Allow: "POST, DELETE" },
        });
      }

      // Chat — two-way conversations (agent ↔ iOS/web/Google Chat).
      // The literal /api/chat/gchat/* routes must precede the :id regex.
      if (path === "/api/chat/gchat/events" && method === "POST") {
        return await handleGChatEvents(request, env, ctx);
      }
      if (
        path === "/api/chat/gchat/config" &&
        (method === "GET" || method === "POST" || method === "DELETE")
      ) {
        return await handleGChatConfig(request, env);
      }
      if (
        path === "/api/chat/matrix/config" &&
        (method === "GET" || method === "POST" || method === "DELETE")
      ) {
        return await handleMatrixConfig(request, env);
      }
      if (path === "/api/chat" && method === "POST") {
        return await handleCreateConversation(request, env, ctx);
      }
      if (path === "/api/chat" && method === "GET") {
        return await handleListConversations(request, env);
      }
      const chatMatch = path.match(/^\/api\/chat\/([a-f0-9-]+)\/(messages|close)$/);
      if (chatMatch && method === "GET" && chatMatch[2] === "messages") {
        return await handleGetConversationMessages(request, env, chatMatch[1]);
      }
      if (chatMatch && method === "POST" && chatMatch[2] === "messages") {
        return await handlePostConversationMessage(request, env, chatMatch[1], ctx);
      }
      if (chatMatch && method === "POST" && chatMatch[2] === "close") {
        return await handleCloseConversation(request, env, chatMatch[1], ctx);
      }

      // Interact relay (/interact command) — laptop browser proxy via Pidgin.
      // Wire paths stay /rc/* for compatibility with already-shipped clients.
      if (path === "/rc/command" && method === "POST") {
        return await handleRcCommand(request, env);
      }
      if (path === "/rc/poll" && method === "GET") {
        return await handleRcPoll(request, env);
      }
      if (path === "/rc/status" && method === "GET") {
        return await handleRcStatus(request, env);
      }
      const rcResultMatch = path.match(/^\/rc\/result\/([a-f0-9-]+)$/);
      if (rcResultMatch && method === "POST") {
        return await handleRcSubmitResult(request, env, rcResultMatch[1]);
      }
      if (rcResultMatch && method === "GET") {
        return await handleRcGetResult(request, env, rcResultMatch[1]);
      }

      if (path === "/api/document-audience") return editionDocumentAudienceEnabled(env) ? await handleDocumentAudience(request, env) : json({ok:false,error:"Not found"},404);

      // Batch: each item is a request of its own for its single route, served through the same
      // router and the edition's metering, so the item meets every check that route does.
      if (path === "/api/batch" && method === "POST") {
        return await handleBatch(request, env, (item) => editionMeterRequest(item, env, ctx, () => coreRouter.fetch(item, env, ctx)));
      }

      // Messages
      if (path === "/api/messages" && method === "POST") {
        return await handlePostMessage(request, env, ctx);
      }
      if (path === "/api/messages" && method === "GET") {
        return await handleGetMessages(request, env);
      }
      const draftMatch = path.match(/^\/api\/drafts\/([A-Za-z0-9_-]{8,64})(\/commit)?$/);
      if (draftMatch) {
        if (draftMatch[2] && method === "POST") return await handleCommitDraft(request, env, draftMatch[1]);
        if (!draftMatch[2] && method === "PUT") return await handlePutDraft(request, env, draftMatch[1]);
        if (!draftMatch[2] && method === "DELETE") return await handleDeleteDraft(request, env, draftMatch[1]);
      }
      if (path === "/api/messages/unread-count" && method === "GET") {
        const userId = await resolveCallerUserId(request, env);
        if (!userId) return unauthorized();
        const row = await env.DB.prepare(`SELECT COUNT(*) as count FROM messages WHERE team_id IS NULL AND read = 0 AND ${messageReadSql("messages")}`).bind(userId, userId).first<{ count: number }>();
        return json({ ok: true, data: { count: row?.count ?? 0 } });
      }
      if (path === "/api/messages/count" && method === "GET") {
        const userId = await resolveCallerUserId(request, env);
        if (!userId) return unauthorized();
        const [totalRow, unreadRow, questionsRow, urgentRow] = await Promise.all([
          env.DB.prepare(`SELECT COUNT(*) as count FROM messages WHERE team_id IS NULL AND ${messageReadSql("messages")}`).bind(userId, userId).first<{ count: number }>(),
          env.DB.prepare(`SELECT COUNT(*) as count FROM messages WHERE team_id IS NULL AND ${messageReadSql("messages")} AND read = 0`).bind(userId, userId).first<{ count: number }>(),
          env.DB.prepare(`SELECT COUNT(*) as count FROM messages WHERE team_id IS NULL AND ${messageReadSql("messages")} AND type = 'question' AND reply IS NULL`).bind(userId, userId).first<{ count: number }>(),
          env.DB.prepare(`SELECT COUNT(*) as count FROM messages WHERE team_id IS NULL AND ${messageReadSql("messages")} AND priority = 'urgent' AND read = 0`).bind(userId, userId).first<{ count: number }>(),
        ]);
        return json({
          ok: true,
          data: {
            total: totalRow?.count ?? 0,
            unread: unreadRow?.count ?? 0,
            urgent_unread: urgentRow?.count ?? 0,
            unanswered_questions: questionsRow?.count ?? 0,
          },
        });
      }
      if (path === "/api/stats" && method === "GET") {
        const userId = await resolveCallerUserId(request, env);
        if (!userId) return unauthorized();
        const [dailyRows, projectRows, modelRows] = await Promise.all([
          env.DB.prepare(
            `SELECT date(created_at) as day, COUNT(*) as count FROM messages
             WHERE user_id = ? AND ${messageReadSql("messages")} AND created_at >= date('now', '-7 days')
             GROUP BY day ORDER BY day DESC`
          ).bind(userId, userId, userId).all<{ day: string; count: number }>(),
          env.DB.prepare(
            `SELECT instance_project as project, COUNT(*) as count FROM messages
             WHERE user_id = ? AND team_id IS NULL AND ${messageReadSql("messages")}
             GROUP BY instance_project ORDER BY count DESC LIMIT 10`
          ).bind(userId, userId, userId).all<{ project: string; count: number }>(),
          env.DB.prepare(
            `SELECT instance_model as model, COUNT(*) as count FROM messages
             WHERE user_id = ? AND ${messageReadSql("messages")}
             GROUP BY instance_model ORDER BY count DESC LIMIT 10`
          ).bind(userId, userId, userId).all<{ model: string; count: number }>(),
        ]);
        return json({
          ok: true,
          data: {
            messages_per_day: dailyRows.results,
            top_projects: projectRows.results,
            top_models: modelRows.results,
          },
        });
      }
      if (path === "/api/messages/read-all" && method === "PATCH") {
        return await handleMarkAllRead(request, env);
      }
      if (path === "/api/messages/bulk-archive" && method === "POST") {
        return await handleBulkArchive(request, env);
      }
      const archiveMatch = path.match(/^\/api\/messages\/([a-f0-9-]+)\/archive$/);
      if (archiveMatch && method === "POST") {
        return await handleArchiveMessage(request, env, archiveMatch[1]);
      }
      const unarchiveMatch = path.match(/^\/api\/messages\/([a-f0-9-]+)\/unarchive$/);
      if (unarchiveMatch && method === "POST") {
        return await handleUnarchiveMessage(request, env, unarchiveMatch[1]);
      }
      const dismissMatch = path.match(/^\/api\/messages\/([a-f0-9-]+)\/dismiss$/);
      if (dismissMatch && method === "POST") {
        return await handleDismissMessage(request, env, dismissMatch[1]);
      }
      const pinMatch = path.match(/^\/api\/messages\/([a-f0-9-]+)\/pin$/);
      if (pinMatch && method === "POST") {
        return await handlePinMessage(request, env, pinMatch[1]);
      }
      const messagePriorityMatch = path.match(/^\/api\/messages\/([a-f0-9-]+)\/priority$/);
      if (messagePriorityMatch && method === "PATCH") {
        return await handleUpdatePriority(request, env, messagePriorityMatch[1]);
      }
      const messageContextMatch = path.match(/^\/api\/messages\/([a-f0-9-]+)\/context$/);
      if (messageContextMatch && method === "GET") {
        return await handleGetMessageContext(request, env, messageContextMatch[1]);
      }
      const messageMatch = path.match(/^\/api\/messages\/([a-f0-9-]+)$/);
      if (messageMatch && method === "GET") {
        return await handleGetMessage(request, env, messageMatch[1]);
      }
      if (messageMatch && method === "PATCH") {
        return await handleMarkMessageRead(request, env, messageMatch[1]);
      }
      if (messageMatch && method === "DELETE") {
        return await handleDeleteMessage(request, env, messageMatch[1]);
      }
      if (path === "/api/commute" && method === "GET") {
        return await handleGetCommuteBriefings(request, env);
      }
      if (path === "/api/commute/latest" && method === "GET") {
        return await handleGetLatestCommute(request, env);
      }
      if (path === "/api/commute/playlist" && method === "GET") {
        return await handleGetPlaylist(request, env);
      }
      if (path === "/api/commute/playlist" && (method === "POST" || method === "PUT")) {
        return await handleSetPlaylist(request, env);
      }
      if (path === "/api/commute/playlist/add" && method === "POST") {
        return await handleAddToPlaylist(request, env);
      }
      if (path === "/api/commute/playlist/remove" && method === "POST") {
        return await handleRemoveFromPlaylist(request, env);
      }
      if (path === "/api/commute/playlist/clear" && method === "POST") {
        return await handleClearPlaylist(request, env);
      }
      if (path === "/api/commute/playlist/generate" && method === "POST") {
        return await handleGeneratePlaylistBriefing(request, env);
      }
      if (path === "/api/commute/source" && method === "GET") {
        return await handleGetCommuteSource(request, env);
      }
      if (path === "/api/commute/source" && method === "POST") {
        return await handleSetCommuteSource(request, env);
      }
      const commuteTranscriptMatch = path.match(/^\/api\/commute\/([a-f0-9-]+)\/transcript$/);
      if (commuteTranscriptMatch && method === "GET") {
        return await handleGetCommuteTranscript(request, env, commuteTranscriptMatch[1]);
      }
      const commuteAudioMatch = path.match(/^\/api\/commute\/([a-f0-9-]+)\/audio$/);
      if (commuteAudioMatch && (method === "GET" || method === "HEAD")) {
        return await handleGetCommuteAudio(request, env, commuteAudioMatch[1]);
      }
      if (path === "/commute/latest" && method === "GET") {
        return await handleOpenLatestCommute(request, env);
      }

      // Audio — uploads and document narrations; commute briefings are listed too.
      if (path === "/api/audio" && method === "POST") {
        return await handlePostAudio(request, env);
      }
      if (path === "/api/audio" && method === "GET") {
        return await handleListAudio(request, env);
      }
      const audioMatch = path.match(/^\/api\/audio\/([^/]+)(?:\/(stream|transcript))?$/);
      if (audioMatch) {
        const [, audioId, audioPart] = audioMatch;
        if (audioPart === "stream" && (method === "GET" || method === "HEAD")) {
          return await handleAudioStream(request, env, audioId);
        }
        if (audioPart === "transcript" && method === "GET") {
          return await handleAudioTranscript(request, env, audioId);
        }
        if (!audioPart && method === "GET") return await handleGetAudio(request, env, audioId);
        if (!audioPart && method === "PATCH") return await handlePatchAudio(request, env, audioId);
        if (!audioPart && method === "DELETE") return await handleDeleteAudio(request, env, audioId);
      }

      // Reply
      if (path === "/api/reply" && method === "POST") {
        return await handlePostReply(request, env, ctx);
      }

      // Replies (a bot checks for the owner's reply)
      const repliesMatch = path.match(/^\/api\/replies\/([a-f0-9-]+)$/);
      if (repliesMatch && method === "GET") {
        return await handleGetReplies(request, env, repliesMatch[1], ctx);
      }

      // Document viewer — /docs/:id (canonical) and /api/docs/:id (legacy)
      const docMatch = path.match(/^\/(?:api\/)?docs\/([a-f0-9-]+)$/);
      if (docMatch && method === "GET") {
        return await handleGetDoc(request, env, docMatch[1], ctx, editionReaderLabels());
      }

      // Interactive document viewer — /idoc/:id (scripts run, strict CSP)
      const idocMatch = path.match(/^\/idoc\/([a-f0-9-]+)$/);
      if (idocMatch && method === "GET") {
        return await handleGetInteractiveDoc(request, env, idocMatch[1], ctx);
      }

      // Artifacts — versioned, self-contained pages at /a/:id.
      // Literal sub-paths (share, rt/*) must precede the :id regex.
      if (path === "/api/artifacts" && method === "POST") {
        return await handlePublishArtifact(request, env, ctx);
      }
      if (path === "/api/artifacts" && method === "GET") {
        return await handleListArtifacts(request, env);
      }
      if (path === "/api/artifacts/telemetry" && method === "POST") {
        return await handleArtifactTelemetry(request, env);
      }
      const artifactShareMatch = path.match(/^\/api\/artifacts\/([a-f0-9-]+)\/share$/);
      if (artifactShareMatch && method === "POST") {
        return await handleShareArtifact(request, env, artifactShareMatch[1]);
      }
      const artifactRtMatch = path.match(/^\/api\/artifacts\/([a-f0-9-]+)\/rt\/(complete|storage)$/);
      if (artifactRtMatch && method === "POST") {
        return artifactRtMatch[2] === "complete"
          ? await handleArtifactRuntimeComplete(request, env, artifactRtMatch[1])
          : await handleArtifactRuntimeStorage(request, env, artifactRtMatch[1]);
      }
      const artifactMatch = path.match(/^\/api\/artifacts\/([a-f0-9-]+)$/);
      if (artifactMatch && method === "GET") {
        return await handleGetArtifactMeta(request, env, artifactMatch[1]);
      }
      if (artifactMatch && method === "PATCH") {
        return await handlePatchArtifact(request, env, artifactMatch[1]);
      }
      if (artifactMatch && method === "DELETE") {
        return await handleDeleteArtifact(request, env, artifactMatch[1]);
      }

      // Artifact viewer + same-origin assets (asset literals before :id)
      { const asset = await artifactAssetResponse(request, env, path); if (asset) return asset; }
      const artifactViewMatch = path.match(/^\/a\/([a-f0-9-]+)$/);
      if (artifactViewMatch && method === "GET") {
        return await handleServeArtifact(request, env, artifactViewMatch[1]);
      }

      // Latest client build — apps poll GET; a deploy script POSTs
      if (path === "/api/client-build" && method === "GET") {
        return await handleGetClientBuild(request, env);
      }
      if (path === "/api/client-build" && method === "POST") {
        return await handlePostClientBuild(request, env);
      }

      // Social preview (Open Graph / Twitter Card) — public, token-gated
      const previewImageMatch = path.match(/^\/p\/([a-f0-9-]+)\/og\.png$/);
      if (previewImageMatch && method === "GET") {
        return await handlePreviewImage(request, env, previewImageMatch[1]);
      }
      const previewMatch = path.match(/^\/p\/([a-f0-9-]+)$/);
      if (previewMatch && method === "GET") {
        return await handlePreviewDoc(request, env, previewMatch[1]);
      }

      // Generate magic share link for a doc
      const shareMatch = path.match(/^\/(?:api\/)?docs\/([a-f0-9-]+)\/share$/);
      if (shareMatch && method === "POST") {
        return await handleShareDoc(request, env, shareMatch[1]);
      }

      // Client-side access event logging (beacon endpoint)
      if (path === "/api/docs/log" && method === "POST") {
        return await handleDocLog(request, env, ctx);
      }

      // Doc version history (must be before the :id match)
      if (path === "/api/docs/versions" && method === "GET") {
        return await handleGetDocVersions(request, env);
      }

      // Documents list — shows active docs plus pinned docs that have been dismissed
      if (path === "/api/docs" && method === "GET") {
        const docUrl = new URL(request.url);
        docUrl.searchParams.set("type", "document");
        docUrl.searchParams.set("docs_view", "true");
        const docRequest = new Request(docUrl.toString(), request);
        return await handleGetMessages(docRequest, env);
      }

      // Audit log
      if (path === "/api/audit" && method === "GET") {
        const hasSession = await verifySession(request.headers, env.SESSIONS, env);
        const hasApiKey = await verifyOwnerCredential(request.headers, env);
        if (!hasSession && !hasApiKey) return unauthorized();
        const rawLimit = parseInt(url.searchParams.get("limit") || "50");
        const auditLimit = Number.isNaN(rawLimit) ? 50 : Math.min(rawLimit, 200);
        const result = await env.DB.prepare(
          "SELECT id, action, instance_id, details, created_at FROM audit_log ORDER BY created_at DESC LIMIT ?"
        ).bind(auditLimit).all();
        return json({ ok: true, data: result.results });
      }

      // Design systems — import route must be matched before the {name} regex
      // below, since "import" would otherwise be captured as a design-system name.
      if (path === "/api/design-systems" && method === "GET") {
        return await handleListDesignSystems(request, env);
      }
      if (path === "/api/design-systems/import" && method === "POST") {
        return await handleImportDesignSystem(request, env);
      }
      {
        const dsMatch = path.match(/^\/api\/design-systems\/([a-z0-9][a-z0-9-]{1,63})$/);
        if (dsMatch) {
          if (method === "GET") return await handleGetDesignSystem(request, env, dsMatch[1]);
          if (method === "PUT") return await handlePutDesignSystem(request, env, dsMatch[1]);
          if (method === "DELETE") return await handleDeleteDesignSystem(request, env, dsMatch[1]);
        }
      }

      // Owner JSON (session + OWNER_EMAIL, same rule as the /admin/users HTML
      // pages; the handlers 404 on the public site like those pages do).
      if (path === "/api/owner/users" && method === "GET") return await handleOwnerUsers(request, env);
      if (path === "/api/owner/invite-code" && method === "POST") return await handleOwnerInviteCode(request, env);

      // Admin API (Bearer ADMIN_API_KEY; each handler gates via resolveAdminUser).
      // Exact-match routes precede the /users/:id regex so the list route can't be
      // swallowed by it. These prefixes are distinct from every earlier matcher
      // (/admin/users is an HTML page; /api/messages|/rc|/p regexes are anchored
      // elsewhere), so nothing above shadows /api/admin/*.
      if (path === "/api/admin/users" && method === "GET") return await handleAdminUsers(request, env);
      if (path === "/api/admin/messages" && method === "GET") return await handleAdminMessages(request, env);
      if (path === "/api/admin/stats" && method === "GET") return await handleAdminStats(request, env);
      if (path === "/api/admin/sql" && method === "POST") return await handleAdminSql(request, env);
      if (path === "/api/admin/invite" && method === "POST") return await handleAdminInvite(request, env);
      {
        const m = path.match(/^\/api\/admin\/users\/([^/]+)(?:\/(suspend|activate))?$/);
        if (m && method === "GET" && !m[2]) return await handleAdminUser(request, env, m[1]);
        if (m && method === "POST" && m[2] === "suspend") return await handleAdminSuspend(request, env, m[1], "suspended");
        if (m && method === "POST" && m[2] === "activate") return await handleAdminSuspend(request, env, m[1], "active");
      }

      // Live instances quick-filter
      if (path === "/api/instances/live" && method === "GET") {
        const userId = await resolveCallerUserId(request, env);
        if (!userId) return unauthorized();
        const rows = await env.DB.prepare(
          `SELECT instance_id, model, project, working_on, source, registered_at, last_heartbeat FROM instances
           WHERE user_id = ? AND last_heartbeat > datetime('now', '-5 minutes') ORDER BY last_heartbeat DESC`
        ).bind(userId).all<{ instance_id: string; model: string; project: string; working_on: string | null; source: string; registered_at: string; last_heartbeat: string }>();
        const instances = rows.results.map((r) => ({ ...r, status: "live" }));
        return json({ ok: true, data: instances });
      }

      // Registry
      if (path === "/api/register" && method === "POST") {
        return await handleRegister(request, env);
      }
      if (path === "/api/registry" && method === "GET") {
        return await handleGetRegistry(request, env);
      }
      const heartbeatMatch = path.match(/^\/api\/register\/([^/]+)\/heartbeat$/);
      if (heartbeatMatch && method === "POST") {
        return await handleHeartbeat(request, env, heartbeatMatch[1]);
      }
      const deregMatch = path.match(/^\/api\/register\/([^/]+)$/);
      if (deregMatch && method === "GET") {
        return await handleGetInstance(request, env, deregMatch[1]);
      }
      if (deregMatch && method === "DELETE") {
        return await handleDeregister(request, env, deregMatch[1]);
      }

      // Email relay — send via pidgin-server's Resend credentials
      if (path === "/api/email" && method === "POST") {
        return await handlePostEmail(request, env);
      }

      // Preview (ephemeral HTML viewer — API key to create, public UUID to view)
      if (path === "/preview" && method === "POST") {
        return await handlePostPreview(request, env);
      }
      const previewViewMatch = path.match(/^\/preview\/([a-f0-9-]+)$/);
      if (previewViewMatch && method === "GET") {
        return await handleGetPreview(request, env, previewViewMatch[1]);
      }

      // Auth
      if (path === "/auth/login" && method === "POST") {
        return await handleLogin(request, env);
      }
      if (path === "/auth/verify" && method === "GET") {
        return await handleVerify(request, env);
      }
      if (path === "/auth/oauth/apple" && method === "POST") {
        return await handleOAuthLogin(request, env, "apple");
      }
      if (path === "/auth/oauth/google" && method === "POST") {
        return await handleOAuthLogin(request, env, "google");
      }
      if (path === "/auth/oauth/apple/web" && method === "POST") {
        return await handleOAuthLoginWeb(request, env, "apple");
      }
      if (path === "/auth/oauth/google/web" && method === "POST") {
        return await handleOAuthLoginWeb(request, env, "google");
      }
      if (path === "/api/device" && method === "POST") {
        return await handleRegisterDevice(request, env);
      }

      // Linked login identities (multi-provider SSO) — session-only handlers
      if (path === "/api/identities" && method === "GET") {
        return await handleListIdentities(request, env);
      }
      if (path === "/api/identities" && method === "POST") {
        return await handleLinkIdentity(request, env);
      }
      if (path === "/api/identities" && method === "DELETE") {
        return await handleUnlinkIdentity(request, env);
      }

      // Profile aggregate + device revoke — session-only, same rationale
      if (path === "/api/profile" && method === "GET") {
        return await handleGetProfile(request, env);
      }
      if (path === "/api/devices" && method === "DELETE") {
        return await handleRevokeDevice(request, env);
      }

      // Invite management
      if (path === "/api/invite" && method === "POST") {
        return await handleInviteUser(request, env);
      }

      // Invite acceptance (public — token is the auth)
      if (path === "/auth/invite" && method === "GET") {
        return await handleAcceptInvite(request, env);
      }

      // Generate invite code (owner API key only)
      if (path === "/api/invite-code" && method === "POST") {
        const authedUser = await resolveApiKeyUser(request.headers, env);
        if (!authedUser) return unauthorized();
        if (authedUser.email.toLowerCase() !== env.OWNER_EMAIL?.toLowerCase()) {
          return json({ ok: false, error: "only the owner can create invite codes" }, 403);
        }

        let body: { label?: string; max_uses?: number };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          body = {};
        }

        const maxUses = Math.min((body.max_uses ?? 1), 100);
        const code = await createInviteCode(env, authedUser.email, maxUses);

        return json({ ok: true, data: { code, max_uses: maxUses, expires_in: "7 days" } }, 201);
      }

      // Per-user API keys — session-only (resolveSessionUserId); used by the
      // macOS app to mint a durable pidgin_sk_ key it shares with the CLI.
      if (path === "/api/keys" && method === "POST") return await handleApiKeysCreate(request, env);
      if (path === "/api/keys" && method === "GET") return await handleApiKeysList(request, env);
      const keyRevokeMatch = path.match(/^\/api\/keys\/([a-f0-9]{64})$/);
      if (keyRevokeMatch && method === "DELETE") return await handleApiKeysRevoke(request, env, keyRevokeMatch[1]);

      if (path === "/api/setup" && method === "GET") {
        const email = await verifySession(request.headers, env.SESSIONS, env);
        if (!email) return unauthorized();
        const status = await getSetupStatus(env);
        return json({ ok: true, data: { ...status, can_edit: await canEditSetup(env, email) } });
      }
      if (path === "/api/setup" && method === "POST") {
        return await handleSetupApi(request, env);
      }

      if (path === "/setup" && method === "GET") {
        const email = await verifySession(request.headers, env.SESSIONS, env);
        if (!email) return await editionLoginPage(env);
        // Reuse the already-verified session email rather than re-running
        // verifySession via resolveSessionUserId (saves a KV read + renew-write).
        const userRow = await env.DB.prepare(
          `SELECT id FROM users WHERE email = ? AND status = 'active'
           AND ${editionAccountActiveSql()}`
        ).bind(email.toLowerCase()).first<{ id: string }>();
        const status = await getSetupStatus(env);
        const apiKeys = userRow ? await listKeysForUser(env, userRow.id) : [];
        const teamsChannels = userRow ? await editionRoutes().teamsChannels?.(env, userRow.id) ?? [] : [];
        const accountSections = await editionAccountSections(env, userRow?.id ?? null);
        const flashParam = url.searchParams.get("saved");
        const flash =
          flashParam === "microsoft365"
            ? "Microsoft 365 saved"
            : flashParam === "onedrive"
            ? "OneDrive saved"
            : flashParam === "commute"
            ? "Audio voice settings saved"
            : flashParam === "key-revoked"
            ? "API key revoked"
            : undefined;
        return withNavShell(setupPage(status, { base, brand: editionBrand(env), flash, apiKeys, accountSections,
          showOAuthConnections: !editionPublicSite(env), canEdit: await canEditSetup(env, email),
          teamsChannels }), shellFor(userRow?.id ?? ""));
      }
      if (path === "/setup" && method === "POST") {
        return await handleSetupForm(request, env);
      }

      // Web key management (session-only) — reuses the same core fns as /api/keys
      if (path === "/setup/keys" && method === "POST") {
        const userId = await resolveSessionUserId(request, env);
        if (!userId) return await editionLoginPage(env);
        const setupEmail = await verifySession(request.headers, env.SESSIONS, env);
        const canEdit = setupEmail ? await canEditSetup(env, setupEmail) : false;
        const form = await request.formData();
        const label = ((form.get("label") as string) || "").trim() || "web";
        const result = await createKeyForUser(env, userId, label);
        const status = await getSetupStatus(env);
        const apiKeys = await listKeysForUser(env, userId);
        const teamsChannels = await editionRoutes().teamsChannels?.(env, userId) ?? [];
        if ("error" in result) {
          const message = result.error === "limit" ? "Key limit reached (max 10)." : "Too many key requests, try again later.";
          return withNavShell(setupPage(status, { base, brand: editionBrand(env), error: message, apiKeys, showOAuthConnections: !editionPublicSite(env), canEdit, teamsChannels }), shellFor(userId));
        }
        return withNavShell(setupPage(status, { base, brand: editionBrand(env), apiKeys, newKey: result.key, showOAuthConnections: !editionPublicSite(env), canEdit, teamsChannels }), shellFor(userId));
      }
      if (path === "/setup/keys/revoke" && method === "POST") {
        const userId = await resolveSessionUserId(request, env);
        if (!userId) return await editionLoginPage(env);
        const form = await request.formData();
        const keyHash = ((form.get("key_hash") as string) || "").trim();
        if (keyHash) await revokeKeyForUser(env, userId, keyHash);
        return new Response(null, { status: 303, headers: { Location: "/setup?saved=key-revoked" } });
      }

      { const routed = await editionRoutes().hostingPages?.(routeContext); if (routed) return routed; }
      // Without an edition page at the root, a visit goes to setup, which shows the sign-in page when signed out.
      if (path === "/" && method === "GET") return new Response(null, { status: 302, headers: { Location: "/setup" } });

      if (path === "/inbox" && method === "GET") {
        const userId = await resolveCallerUserId(request, env);
        if (!userId) return await editionLoginPage(env);
        const typeFilter = url.searchParams.get("type") || "";
        const projectFilter = url.searchParams.get("project") || "";
        const sourceFilter = url.searchParams.get("source") || "";
        const unreadOnly = url.searchParams.get("unread") === "true";
        const repliedParam = url.searchParams.get("replied");
        const rawOffset = parseInt(url.searchParams.get("offset") || "0");
        const inboxOffset = Number.isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;
        const PAGE = 50;
        let inboxQuery = "SELECT * FROM messages";
        // Always scope to the caller (owner included), regardless of which other
        // filters are present, so the inbox never lists another tenant's rows.
        const conditions: string[] = [messageReadSql("messages"), "team_id IS NULL", "COALESCE(is_latest, 1) = 1"];
        const binds: (string | number)[] = [userId, userId];
        if (typeFilter) { conditions.push("type = ?"); binds.push(typeFilter); }
        if (projectFilter) { conditions.push("instance_project = ?"); binds.push(projectFilter); }
        if (sourceFilter) { conditions.push("instance_source = ?"); binds.push(sourceFilter); }
        if (unreadOnly) { conditions.push("read = 0"); }
        if (repliedParam === "false") { conditions.push("reply IS NULL"); }
        else if (repliedParam === "true") { conditions.push("reply IS NOT NULL"); }
        if (conditions.length) inboxQuery += " WHERE " + conditions.join(" AND ");
        inboxQuery += " ORDER BY CASE priority WHEN 'urgent' THEN 0 ELSE 1 END, created_at DESC LIMIT ? OFFSET ?";
        binds.push(PAGE + 1, inboxOffset);
        const [result, instanceRow, pendingRow, teamUpdates] = await Promise.all([
          env.DB.prepare(inboxQuery).bind(...binds).all(),
          env.DB.prepare("SELECT COUNT(*) as count FROM instances WHERE user_id = ?").bind(userId).first<{ count: number }>(),
          env.DB.prepare(`SELECT COUNT(*) as count FROM messages WHERE team_id IS NULL AND type = 'question' AND reply IS NULL AND ${messageReadSql("messages")}`).bind(userId, userId).first<{ count: number }>(),
          // Team updates (inbox items) sit above the messages on the first page.
          inboxOffset === 0 ? listInboxItems(env, userId, { limit: 20 }) : null,
        ]);
        const hasMore = result.results.length > PAGE;
        const messages = hasMore ? result.results.slice(0, PAGE) : result.results;
        const blockMap = await loadMessageBlocks(
          env,
          messages.map((message) => String((message as Record<string, unknown>).id))
        );
        for (const message of messages as Array<Record<string, unknown>>) {
          message.visual_count = (blockMap.get(String(message.id)) ?? []).filter(
            (block) => block.type === "artifact"
          ).length;
        }
        return withNavShell(inboxPage(messages, { typeFilter, projectFilter, sourceFilter, unreadOnly, repliedFilter: repliedParam || "", offset: inboxOffset, hasMore, instanceCount: instanceRow?.count ?? 0, pendingCount: pendingRow?.count ?? 0, teamUpdates: teamUpdates?.items ?? [], base, shell: editionShell(env, { base, canManagePeople: await canManagePeopleFor(userId) }) }), shellFor(userId));
      }

      // Documents TOC (session auth required)
      if (path === "/toc" && method === "GET") {
        const userId = await resolveCallerUserId(request, env);
        if (!userId) return await editionLoginPage(env);
        const docs = await env.DB.prepare(
          `SELECT * FROM messages WHERE team_id IS NULL AND type = 'document' AND (doc_key IS NOT NULL OR body IS NOT NULL) AND COALESCE(is_latest, 1) = 1 AND ${messageReadSql("messages")} ORDER BY created_at DESC`
        ).bind(userId, userId).all();
        const tocTeams = await listTeams(env, userId);
        return withNavShell(tocPage(docs.results, tocTeams, base, editionShell(env, { base, canManagePeople: await canManagePeopleFor(userId, tocTeams) })), shellFor(userId));
      }
      { const routed = await editionRoutes().hostingWorkspacePages?.(routeContext); if (routed) return routed; }
      // Commute is now Audio. /commute/latest stays as it was.
      if (path === "/commute" && method === "GET") {
        return new Response(null, { status: 302, headers: { Location: "/audio" } });
      }
      { const routed = await editionRoutes().teamsSettings?.(routeContext); if (routed) return routed; }
      { const routed = await editionRoutes().teamsPages?.(routeContext); if (routed) return routed; }

      if (path === "/registry" && method === "GET") {
        const userId = await resolveCallerUserId(request, env);
        if (!userId) return await editionLoginPage(env);
        const instances = await env.DB.prepare(
          "SELECT * FROM instances WHERE user_id = ? ORDER BY last_heartbeat DESC"
        ).bind(userId).all();
        return withNavShell(registryPage(instances.results, base), shellFor(userId));
      }

      if (path === "/stats" && method === "GET") {
        const userId = await resolveCallerUserId(request, env);
        if (!userId) return await editionLoginPage(env);
        const [dailyRows, projectRows, modelRows] = await Promise.all([
          env.DB.prepare(
            `SELECT date(created_at) as day, COUNT(*) as count FROM messages
             WHERE user_id = ? AND ${messageReadSql("messages")} AND created_at >= date('now', '-7 days')
             GROUP BY day ORDER BY day DESC`
          ).bind(userId, userId, userId).all<{ day: string; count: number }>(),
          env.DB.prepare(
            `SELECT instance_project as project, COUNT(*) as count FROM messages
             WHERE user_id = ? AND ${messageReadSql("messages")} GROUP BY instance_project ORDER BY count DESC LIMIT 10`
          ).bind(userId, userId, userId).all<{ project: string; count: number }>(),
          env.DB.prepare(
            `SELECT instance_model as model, COUNT(*) as count FROM messages
             WHERE user_id = ? AND ${messageReadSql("messages")} GROUP BY instance_model ORDER BY count DESC LIMIT 10`
          ).bind(userId, userId, userId).all<{ model: string; count: number }>(),
        ]);
        return withNavShell(statsPage({
          messages_per_day: dailyRows.results,
          top_projects: projectRows.results,
          top_models: modelRows.results,
        }, base), shellFor(userId));
      }

      if (path === "/auth/login-form" && method === "GET") {
        return await editionLoginPage(env, undefined, url.searchParams.get("next") || undefined);
      }

      if (path === "/auth/login-form" && method === "POST") {
        const formData = await request.formData();
        const email = formData.get("email") as string;
        const next = (formData.get("next") as string) || undefined;
        if (!email) return await editionLoginPage(env, "Email required");
        // Invite-only: send a non-member to the members-only page rather than a
        // silent "check your email" for a link that will never arrive. (This
        // reveals membership on the web form — acceptable for an invite-only
        // tool.) Linked identities count as membership.
        const member = await findActiveUserByEmail(env, email);
        if (!member) {
          return new Response(null, { status: 303, headers: { Location: "/members-only" } });
        }
        // Reuse the JSON login handler
        const loginRequest = new Request(request.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, next }),
        });
        const loginResponse = await handleLogin(loginRequest, env);
        if (!loginResponse.ok) {
          let error = "Login email failed";
          try {
            const body = (await loginResponse.json()) as { error?: string };
            if (body.error) error = body.error;
          } catch {}
          return await editionLoginPage(env, error, next);
        }
        return new Response(
          `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Check Email</title>
          <style>body{font-family:Inter,sans-serif;background:#FBF7F0;display:flex;
          justify-content:center;align-items:center;min-height:100vh;margin:0;padding:1rem;box-sizing:border-box}
          .card{background:#fff;border-radius:12px;padding:2.5rem;width:100%;max-width:380px;
          text-align:center;box-shadow:0 2px 20px rgba(0,0,0,.06)}
          h2{color:#3D2E2A;margin:0 0 .75rem;font-size:1.4rem}p{color:#6B5550;font-size:1rem;line-height:1.5;margin:0}</style></head>
          <body><div class="card"><h2>Check your email</h2>
          <p>If that email is registered, ${editionProductName()} sent you a login link. It expires in 5 minutes.</p>
          </div></body></html>`,
          { headers: { "Content-Type": "text/html" } }
        );
      }

      if (path === "/auth/logout" && method === "GET") {
        const signedOutUser = await resolveSessionUserId(request, env);
        const headers = new Headers({ Location: "/", "Cache-Control": "no-store" });
        headers.append("Set-Cookie", secureCookie("session", "", 0));
        // An edition may end its own sessions here and clear its own cookies (for example a managed or workspace sign-in).
        await editionRoutes().signOut?.(request, env, signedOutUser, headers);
        // Close the live event sockets this sign-in opened now, not at the next event or heartbeat.
        if (signedOutUser) await recheckEventStreams(env, await streamsOfUser(env, signedOutUser));
        return new Response(null, { status: 302, headers });
      }

      return json({ ok: false, error: "not found" }, 404);
    } catch (err) {
      // An error that an edition throws keeps the edition's own safe response (for example a write gate's 402 or 503 body).
      const edited = editionErrorResponse(err);
      if (edited) return edited;
      if (err instanceof TenantWriteRefused) return Response.json({ok:false,error:err.message,code:err.reason},{status:err.status,headers:corsHeaders()});
      const message = err instanceof Error ? err.message : "internal error";
      return json({ ok: false, error: message }, 500);
    }
  },
  // An edition that gates the work (for example during maintenance) wraps this router.
  scheduled: async (event, env, ctx) => {
    // The five-minute trigger commits idle drafts and nothing else of core's. An edition that shares it runs after the sweep.
    if (event.cron === DRAFT_CRON) {
      try { console.log(await runDraftSweep(env, event.scheduledTime)); } catch (err) { console.error("Draft sweep failed", err); }
      await editionRoutes().scheduled?.(event, env);
      return;
    }
    if (await editionRoutes().scheduled?.(event, env)) return;
    if (event.cron === WORKSPACE_BACKUP_CRON) return runScheduledWorkspaceBackup(env, event.scheduledTime);
    if (event.cron !== HOURLY_CRON) return scheduled(event, env, ctx);
    try { await runGovernedContentCleanup(env); }
    catch { console.warn("Governed content cleanup will retry next run"); }
    await runBatchSweep(env);
    await editionRoutes().hourly?.(event, env);
  },
  queue: async (batch, env) => handleEnhanceQueueBatch(batch, env),
} satisfies ExportedHandler<Env, EnhanceJob>;

/** The self-hosted answer to one request: the preflight, the health check, the edition's metering and hooks, and the router. */
async function serveCoreRequest(request: Request, env: Env, ctx: ExecutionContext, requestID: string): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (path === "/health" && request.method === "GET") return json({ ok: true, data: { status: "healthy" } });
  // An edition may refuse the request before anything runs and meter it after.
  return editionMeterRequest(request, env, ctx, async () => {
    const { beforeApp, afterApp } = editionRoutes();
    try {
      const response = (beforeApp && await beforeApp(request, env, path)) || await coreRouter.fetch(request, env, ctx);
      return afterApp ? await afterApp(request, response, env, requestID) : response;
    } catch (error) {
      const edited = editionErrorResponse(error);
      if (edited) return edited;
      if (error instanceof TenantWriteRefused) return Response.json({ ok: false, error: error.message, code: error.reason }, { status: error.status, headers: corsHeaders() });
      throw error;
    }
  });
}

async function handleCoreRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const requestID = crypto.randomUUID();
  let response: Response;
  try {
    response = await serveCoreRequest(request, env, ctx, requestID);
  } catch {
    // Do not log exception text: provider errors can include private content.
    console.error(JSON.stringify({ event: logEventName("request_error"), request_id: requestID }));
    response = json({ ok: false, error: "internal error" }, 500);
  }
  if (response.status === 101) return response;
  const headers = new Headers(response.headers); headers.set("X-Request-ID", requestID);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** The self-hosted Worker: the router with no edition around it. An edition serves its own entry instead. */
export default {
  ...coreRouter,
  // With BASE_PATH set, the request adapter removes the prefix before anything reads the path, and the
  // response adapter adds it back to Location and Set-Cookie Path. With BASE_PATH empty this is handleCoreRequest itself.
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let base: string;
    try { base = basePath(env); }
    catch {
      // A bad BASE_PATH fails closed: no request reaches a route and no page is built with wrong links.
      console.error(JSON.stringify({ event: logEventName("base_path_invalid") }));
      return json({ ok: false, error: "Server configuration error" }, 500);
    }
    if (!base) return handleCoreRequest(request, env, ctx);
    const stripped = stripBasePath(request, base);
    if (stripped instanceof Response) return stripped;
    return prefixBasePath(await handleCoreRequest(stripped, env, ctx), base);
  },
} satisfies ExportedHandler<Env, EnhanceJob>;
