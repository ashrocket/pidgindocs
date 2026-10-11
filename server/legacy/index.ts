import { Env, ApiResponse, EnhanceJob } from "./types";
import { corsHeaders, json } from "./utils";
import { handlePostMessage, handleGetMessages, handleGetMessage, handleGetMessageContext, handleGetReplies, handleMarkMessageRead, handleMarkAllRead, handleDeleteMessage, handleUpdatePriority, handleArchiveMessage, handleUnarchiveMessage, handleBulkArchive, handleDismissMessage, handlePinMessage } from "./routes/messages";
import { scheduled } from "./cron";
import { handleEnhanceQueueBatch } from "./enhance/consumer";
import { handleGetDoc, handleGetInteractiveDoc, handleShareDoc, handleDocLog, handlePreviewDoc, handlePreviewImage, handleGetDocVersions } from "./routes/docs";
import {
  handlePublishArtifact,
  handleListArtifacts,
  handleGetArtifactMeta,
  handlePatchArtifact,
  handleDeleteArtifact,
  handleShareArtifact,
  handleServeArtifact,
  handleArtifactMermaid,
  handleCuelumeAsset,
  handleArtifactRuntimeScript,
  handleArtifactRuntimeComplete,
  handleArtifactRuntimeStorage,
  handleArtifactTelemetry,
} from "./routes/artifacts";
import { artifactsPage } from "./web/artifacts";
import { listArtifacts, serializeArtifact } from "./artifacts/store";
import { loadWorkspaceTeamViews } from "./workspace-overview";
import { handleGetClientBuild, handlePostClientBuild } from "./routes/client-build";
import { handlePostReply } from "./routes/reply";
import { handleRegister, handleGetRegistry, handleDeregister, handleHeartbeat, handleGetInstance } from "./routes/registry";
import { ensureOwnerExists, findActiveUserByEmail } from "./auth-utils";
import { handleLogin, handleVerify, handleRegisterDevice, handleAppleAppSiteAssociation, handleInviteUser, handleAcceptInvite, handleOAuthLoginWeb } from "./routes/auth";
import { handleOAuthLogin } from "./auth/oauth-login";
import { handleLinkIdentity, handleListIdentities, handleUnlinkIdentity } from "./routes/identities";
import { handleGetProfile, handleRevokeDevice, loadProfile } from "./routes/profile";
import { profilePage } from "./web/profile";
import { handleNotify, handleProviders } from "./routes/notify";
import {
  handleGetCommuteAudio,
  handleGetCommuteBriefings,
  handleGetCommuteTranscript,
  handleGetLatestCommute,
  handleOpenLatestCommute,
} from "./routes/commute";
import {
  handleAddToPlaylist,
  handleClearPlaylist,
  handleGeneratePlaylistBriefing,
  handleGetCommuteSource,
  handleGetPlaylist,
  handleRemoveFromPlaylist,
  handleSetCommuteSource,
  handleSetPlaylist,
} from "./routes/playlist";
import { handleMcp } from "./routes/mcp";
import {
  handleCloseConversation,
  handleCreateConversation,
  handleGChatConfig,
  handleGChatEvents,
  handleGetConversationMessages,
  handleListConversations,
  handleMatrixConfig,
  handlePostConversationMessage,
} from "./routes/chat";
import {
  handleWorkspaceOverview,
  handleCreateComment,
  handleCreateDecisionMemo,
  handleCreateProject,
  handleCreateTeam,
  handleListComments,
  handleListDecisionMemos,
  handleListWorkspaceBackups,
  handleListProjects,
  handleListTeams,
} from "./routes/workspace";
import {
  handleCreateWorkspaceAgent,
  handleGetAgentBoard,
  handleListWorkspaceAgents,
  handlePostAgentBoard,
  handleRevokeWorkspaceAgent,
  handleTombstoneAgentBoardEntry,
} from "./routes/agent-board";
import { handleRcCommand, handleRcPoll, handleRcSubmitResult, handleRcGetResult, handleRcStatus } from "./routes/rc";
import {
  handleOAuthAuthorizationServerMetadata,
  handleOAuthAuthorize,
  handleOAuthProtectedResourceMetadata,
  handleOAuthRegister,
  handleOAuthToken,
} from "./routes/oauth";
import { handlePostPreview, handleGetPreview } from "./routes/preview";
import { handlePostEmail } from "./routes/email";
import { handleSetupApi, handleSetupForm } from "./routes/setup";
import { handleApiKeysCreate, handleApiKeysList, handleApiKeysRevoke, createKeyForUser, listKeysForUser, revokeKeyForUser } from "./routes/keys";
import { handleAdminUsers, handleAdminUser, handleAdminMessages, handleAdminStats, handleAdminSuspend, handleAdminSql, handleAdminInvite } from "./routes/admin";
import {
  handleDeleteDesignSystem,
  handleGetDesignSystem,
  handleImportDesignSystem,
  handleListDesignSystems,
  handlePutDesignSystem,
} from "./routes/design-systems";
import { commutePage, inboxPage, loginPage, membersOnlyPage, registryPage, setupPage, statsPage, tocPage, walkTopicPage } from "./web/index";
import { homePage } from "./web/home";
import { replyHelpPage } from "./web/help";
import { appIconAsset } from "./web/app-icon";
import { adminUsersPage } from "./web/admin-users";
import { messageDetailPage, type MessageDetailRow } from "./web/message-detail";
import { workspacePage } from "./web/workspace";
import { loadMessageBlocks } from "./messages/store";
import { verifySession, verifyApiKey, unauthorized, resolveApiKeyUser, resolveCallerUserId, resolveSessionUserId } from "./middleware";
import { joinPage, joinSentPage } from "./web/join";
import { listCommuteBriefings } from "./commute/store";
import { canListGlobalWorkspaceBackups, listWorkspaceBackups } from "./workspace-backup";
import { getSetupStatus } from "./setup/status";
import { checkRateLimit } from "./ratelimit";
import { createInviteCode } from "./invites";
import {
  handleCreateLibraryProject,
  handleCreateLibraryTag,
  handleDeleteLibraryProject,
  handleDeleteLibraryTag,
  handleFileLibraryItems,
  handleGetLibrary,
  handleUpdateLibraryProject,
  handleUpdateLibraryTag,
} from "./routes/library";
import {
  handleGetLibraryIndex,
  handleLibraryAsk,
  handleLibrarySearch,
  handlePrepareLibraryIndex,
  handleSuggestFiling,
} from "./routes/library-search";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      await ensureOwnerExists(env);

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
            env.DB.prepare("SELECT COUNT(*) as count FROM messages WHERE user_id = ?").bind(userId).first<{ count: number }>(),
            env.DB.prepare("SELECT COUNT(*) as count FROM messages WHERE user_id = ? AND priority = 'urgent' AND read = 0").bind(userId).first<{ count: number }>(),
            env.DB.prepare("SELECT COUNT(*) as count FROM messages WHERE user_id = ? AND read = 0").bind(userId).first<{ count: number }>(),
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

      if ((path === "/walk-topic" || path === "/walk-topic.html") && method === "GET") {
        return walkTopicPage();
      }

      // Notify (Stop hook + external providers)
      if (path === "/api/notify" && method === "POST") {
        return await handleNotify(request, env);
      }
      if (path === "/api/providers" && method === "GET") {
        return await handleProviders(request, env);
      }

      if (path === "/api/workspace/overview" && method === "GET") {
        return handleWorkspaceOverview(request, env);
      }
      if (path === "/api/workspace/teams" && method === "GET") {
        return await handleListTeams(request, env);
      }
      if (path === "/api/workspace/teams" && method === "POST") {
        return await handleCreateTeam(request, env);
      }
      if (path === "/api/workspace/projects" && method === "GET") {
        return await handleListProjects(request, env);
      }
      if (path === "/api/workspace/projects" && method === "POST") {
        return await handleCreateProject(request, env);
      }
      if (path === "/api/workspace/comments" && method === "GET") {
        return await handleListComments(request, env);
      }
      if (path === "/api/workspace/comments" && method === "POST") {
        return await handleCreateComment(request, env);
      }
      if (path === "/api/workspace/memos" && method === "GET") {
        return await handleListDecisionMemos(request, env);
      }
      if (path === "/api/workspace/memos" && method === "POST") {
        return await handleCreateDecisionMemo(request, env);
      }
      if (path === "/api/workspace/backups" && method === "GET") {
        return await handleListWorkspaceBackups(request, env);
      }
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
      const agentBoardMatch = path.match(/^\/api\/agent-board\/([a-f0-9]+)$/);
      if (agentBoardMatch && method === "GET") {
        return await handleGetAgentBoard(request, env, agentBoardMatch[1]);
      }
      if (agentBoardMatch && method === "POST") {
        return await handlePostAgentBoard(request, env, agentBoardMatch[1]);
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
      if (path === "/oauth/authorize" && method === "GET") {
        return await handleOAuthAuthorize(request, env);
      }
      if (path === "/oauth/token" && method === "POST") {
        return await handleOAuthToken(request, env);
      }

      // MCP connector surface
      if (path === "/mcp" && (method === "POST" || method === "DELETE")) {
        return await handleMcp(request, env, ctx);
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

      // Interact relay (/interact command) — laptop browser proxy via PidginDocs.
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

      // Messages
      if (path === "/api/messages" && method === "POST") {
        return await handlePostMessage(request, env, ctx);
      }
      if (path === "/api/messages" && method === "GET") {
        return await handleGetMessages(request, env);
      }
      if (path === "/api/messages/unread-count" && method === "GET") {
        const userId = await resolveCallerUserId(request, env);
        if (!userId) return unauthorized();
        const row = await env.DB.prepare("SELECT COUNT(*) as count FROM messages WHERE read = 0 AND user_id = ?").bind(userId).first<{ count: number }>();
        return json({ ok: true, data: { count: row?.count ?? 0 } });
      }
      if (path === "/api/messages/count" && method === "GET") {
        const userId = await resolveCallerUserId(request, env);
        if (!userId) return unauthorized();
        const [totalRow, unreadRow, questionsRow, urgentRow] = await Promise.all([
          env.DB.prepare("SELECT COUNT(*) as count FROM messages WHERE user_id = ?").bind(userId).first<{ count: number }>(),
          env.DB.prepare("SELECT COUNT(*) as count FROM messages WHERE user_id = ? AND read = 0").bind(userId).first<{ count: number }>(),
          env.DB.prepare("SELECT COUNT(*) as count FROM messages WHERE user_id = ? AND type = 'question' AND reply IS NULL").bind(userId).first<{ count: number }>(),
          env.DB.prepare("SELECT COUNT(*) as count FROM messages WHERE user_id = ? AND priority = 'urgent' AND read = 0").bind(userId).first<{ count: number }>(),
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
             WHERE user_id = ? AND created_at >= date('now', '-7 days')
             GROUP BY day ORDER BY day DESC`
          ).bind(userId).all<{ day: string; count: number }>(),
          env.DB.prepare(
            `SELECT instance_project as project, COUNT(*) as count FROM messages
             WHERE user_id = ?
             GROUP BY instance_project ORDER BY count DESC LIMIT 10`
          ).bind(userId).all<{ project: string; count: number }>(),
          env.DB.prepare(
            `SELECT instance_model as model, COUNT(*) as count FROM messages
             WHERE user_id = ?
             GROUP BY instance_model ORDER BY count DESC LIMIT 10`
          ).bind(userId).all<{ model: string; count: number }>(),
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
      if (commuteAudioMatch && method === "GET") {
        return await handleGetCommuteAudio(request, env, commuteAudioMatch[1]);
      }
      if (path === "/commute/latest" && method === "GET") {
        return await handleOpenLatestCommute(request, env);
      }

      // Reply
      if (path === "/api/reply" && method === "POST") {
        return await handlePostReply(request, env);
      }

      // Replies (bot checks for the owner's reply)
      const repliesMatch = path.match(/^\/api\/replies\/([a-f0-9-]+)$/);
      if (repliesMatch && method === "GET") {
        return await handleGetReplies(request, env, repliesMatch[1], ctx);
      }

      // Document viewer — /docs/:id (canonical) and /api/docs/:id (legacy)
      const docMatch = path.match(/^\/(?:api\/)?docs\/([a-f0-9-]+)$/);
      if (docMatch && method === "GET") {
        return await handleGetDoc(request, env, docMatch[1], ctx);
      }

      // Interactive document viewer — /idoc/:id (scripts run, strict CSP)
      const idocMatch = path.match(/^\/idoc\/([a-f0-9-]+)$/);
      if (idocMatch && method === "GET") {
        return await handleGetInteractiveDoc(request, env, idocMatch[1], ctx);
      }

      // Personal library — private Projects and Tags for docs and artifacts.
      if (path === "/api/library" && method === "GET") {
        return await handleGetLibrary(request, env);
      }
      if (path === "/api/library/projects" && method === "POST") {
        return await handleCreateLibraryProject(request, env);
      }
      if (path === "/api/library/tags" && method === "POST") {
        return await handleCreateLibraryTag(request, env);
      }
      if (path === "/api/library/file" && method === "POST") {
        return await handleFileLibraryItems(request, env);
      }
      // Jevbox library search: JEV routing, passage scoring, cited answers.
      if (path === "/api/library/search" && method === "POST") {
        return await handleLibrarySearch(request, env);
      }
      if (path === "/api/library/ask" && method === "POST") {
        return await handleLibraryAsk(request, env);
      }
      if (path === "/api/library/search/index" && method === "GET") {
        return await handleGetLibraryIndex(request, env);
      }
      if (path === "/api/library/search/index" && method === "POST") {
        return await handlePrepareLibraryIndex(request, env);
      }
      if (path === "/api/library/suggest" && method === "POST") {
        return await handleSuggestFiling(request, env);
      }
      const libraryProjectMatch = path.match(/^\/api\/library\/projects\/([a-f0-9]+)$/);
      if (libraryProjectMatch && method === "PATCH") {
        return await handleUpdateLibraryProject(request, env, libraryProjectMatch[1]);
      }
      if (libraryProjectMatch && method === "DELETE") {
        return await handleDeleteLibraryProject(request, env, libraryProjectMatch[1]);
      }
      const libraryTagMatch = path.match(/^\/api\/library\/tags\/([a-f0-9]+)$/);
      if (libraryTagMatch && method === "PATCH") {
        return await handleUpdateLibraryTag(request, env, libraryTagMatch[1]);
      }
      if (libraryTagMatch && method === "DELETE") {
        return await handleDeleteLibraryTag(request, env, libraryTagMatch[1]);
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
      if (path === "/a/assets/mermaid.js" && method === "GET") {
        return await handleArtifactMermaid(request, env);
      }
      if (path === "/a/assets/cuelume.js" && method === "GET") {
        return await handleCuelumeAsset(request, env);
      }
      if (path === "/a/assets/runtime.js" && method === "GET") {
        return handleArtifactRuntimeScript();
      }
      const artifactViewMatch = path.match(/^\/a\/([a-f0-9-]+)$/);
      if (artifactViewMatch && method === "GET") {
        return await handleServeArtifact(request, env, artifactViewMatch[1]);
      }

      // Latest client build (TestFlight) — apps poll GET; deploy script POSTs
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
        const hasSession = await verifySession(request.headers, env.SESSIONS);
        const hasApiKey = verifyApiKey(request.headers, env.API_KEY);
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

      // Email delivery through this instance's configured provider
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

      // Public join page (invite code flow)
      if (path === "/join" && method === "GET") {
        const token = url.searchParams.get("token");
        if (token) return await handleAcceptInvite(request, env);
        return joinPage();
      }

      if (path === "/join" && method === "POST") {
        // Rate limit: 20 join attempts per IP per hour
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        const joinAllowed = await checkRateLimit(env, `join:${ip}`, 20, 3600);
        if (!joinAllowed) {
          return joinPage("Too many attempts. Try again in an hour.");
        }

        const formData = await request.formData();
        const code = ((formData.get("code") as string) || "").trim().toUpperCase();
        const email = ((formData.get("email") as string) || "").trim().toLowerCase();

        if (!code || !email) return joinPage("Invite code and email are required.");
        if (!/^[^\s@]+@[^\s@]+$/.test(email)) return joinPage("Enter a valid email address.", email);

        // Look up invite code in KV
        const raw = await env.SESSIONS.get(`invite-code:${code}`);
        if (!raw) return joinPage("Invalid or expired invite code.", email);

        const codeData = JSON.parse(raw) as { uses: number; max_uses: number; invited_by: string };
        if (codeData.uses >= codeData.max_uses) {
          return joinPage("This invite code has been fully used.", email);
        }

        // Check if email already registered
        const existing = await env.DB.prepare(
          "SELECT id, status FROM users WHERE email = ?"
        ).bind(email).first<{ id: string; status: string }>();

        if (!existing) {
          // Create pending user
          const userId = crypto.randomUUID().replace(/-/g, "");
          await env.DB.prepare(
            "INSERT INTO users (id, email, invited_by, status) VALUES (?, ?, ?, 'pending')"
          ).bind(userId, email, codeData.invited_by).run();
        }

        // Increment code uses
        codeData.uses += 1;
        await env.SESSIONS.put(`invite-code:${code}`, JSON.stringify(codeData), {
          expirationTtl: 7 * 24 * 60 * 60,
        });

        // Issue a magic token that activates the user on first click (user stays pending until then)
        const magicToken = crypto.randomUUID();
        const workerUrl = env.WORKER_URL || new URL(request.url).origin;
        await env.SESSIONS.put(
          `magic:${magicToken}`,
          JSON.stringify({ email, next: "/toc", activate: true }),
          { expirationTtl: 900 }
        );
        const magicLink = `${workerUrl}/auth/verify?token=${magicToken}`;

        try {
          const { sendOwnerEmail, loginEmailHtml } = await import("./email");
          await sendOwnerEmail(env, "PidginDocs Login", loginEmailHtml(magicLink), email);
        } catch {
          return joinPage("We couldn't send your login email. Try again or contact the admin.", email);
        }

        return joinSentPage(email);
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
        const email = await verifySession(request.headers, env.SESSIONS);
        if (!email) return unauthorized();
        const status = await getSetupStatus(env);
        return json({ ok: true, data: status });
      }
      if (path === "/api/setup" && method === "POST") {
        return await handleSetupApi(request, env);
      }

      if (path === "/setup" && method === "GET") {
        const email = await verifySession(request.headers, env.SESSIONS);
        if (!email) return await loginPage(env);
        // Reuse the already-verified session email rather than re-running
        // verifySession via resolveSessionUserId (saves a KV read + renew-write).
        const userRow = await env.DB.prepare(
          `SELECT id FROM users WHERE email = ? AND status = 'active'`
        ).bind(email.toLowerCase()).first<{ id: string }>();
        const status = await getSetupStatus(env);
        const apiKeys = userRow ? await listKeysForUser(env, userRow.id) : [];
        const flashParam = url.searchParams.get("saved");
        const flash =
          flashParam === "microsoft365"
            ? "Microsoft 365 saved"
            : flashParam === "onedrive"
            ? "OneDrive saved"
            : flashParam === "commute"
            ? "Commute settings saved"
            : flashParam === "key-revoked"
            ? "API key revoked"
            : undefined;
        return setupPage(status, { flash, apiKeys });
      }
      if (path === "/setup" && method === "POST") {
        return await handleSetupForm(request, env);
      }

      // Profile page — session-gated like /setup
      if (path === "/profile" && method === "GET") {
        const email = await verifySession(request.headers, env.SESSIONS);
        if (!email) return await loginPage(env);
        const userRow = await env.DB.prepare(
          `SELECT id, email, created_at, status FROM users WHERE email = ? AND status = 'active'`
        )
          .bind(email.toLowerCase())
          .first<{ id: string; email: string; created_at: string; status: string }>();
        if (!userRow) return await loginPage(env);
        // A failed link redirects back with its message: the page must re-mint
        // its single-use nonce, so the error travels by query param, not JS.
        const linkError = url.searchParams.get("link_error")?.slice(0, 200) || undefined;
        return await profilePage(env, await loadProfile(env, userRow), linkError);
      }

      // Web key management (session-only) — reuses the same core fns as /api/keys
      if (path === "/setup/keys" && method === "POST") {
        const userId = await resolveSessionUserId(request, env);
        if (!userId) return await loginPage(env);
        const form = await request.formData();
        const label = ((form.get("label") as string) || "").trim() || "web";
        const result = await createKeyForUser(env, userId, label);
        const status = await getSetupStatus(env);
        const apiKeys = await listKeysForUser(env, userId);
        if ("error" in result) {
          const message = result.error === "limit" ? "Key limit reached (max 10)." : "Too many key requests, try again later.";
          return setupPage(status, { error: message, apiKeys });
        }
        return setupPage(status, { apiKeys, newKey: result.key });
      }
      if (path === "/setup/keys/revoke" && method === "POST") {
        const userId = await resolveSessionUserId(request, env);
        if (!userId) return await loginPage(env);
        const form = await request.formData();
        const keyHash = ((form.get("key_hash") as string) || "").trim();
        if (keyHash) await revokeKeyForUser(env, userId, keyHash);
        return new Response(null, { status: 303, headers: { Location: "/setup?saved=key-revoked" } });
      }

      // Admin users page — owner session only
      if (path === "/admin/users" && method === "GET") {
        const email = await verifySession(request.headers, env.SESSIONS);
        if (!email || email.toLowerCase() !== env.OWNER_EMAIL?.toLowerCase()) {
          return new Response(null, { status: 302, headers: { Location: "/" } });
        }
        const result = await env.DB.prepare(
          "SELECT id, email, invited_by, created_at, status FROM users ORDER BY created_at ASC"
        ).all<{ id: string; email: string; invited_by: string | null; created_at: string; status: string }>();
        return adminUsersPage(result.results, env.OWNER_EMAIL);
      }

      if (path === "/admin/users/invite-code" && method === "POST") {
        const email = await verifySession(request.headers, env.SESSIONS);
        if (!email || email.toLowerCase() !== env.OWNER_EMAIL?.toLowerCase()) {
          return new Response(null, { status: 302, headers: { Location: "/" } });
        }
        const code = await createInviteCode(env, email);

        const result = await env.DB.prepare(
          "SELECT id, email, invited_by, created_at, status FROM users ORDER BY created_at ASC"
        ).all<{ id: string; email: string; invited_by: string | null; created_at: string; status: string }>();
        return adminUsersPage(result.results, env.OWNER_EMAIL, code);
      }

      // Web UI
      if (path === "/" && method === "GET") {
        const email = await verifySession(request.headers, env.SESSIONS);
        if (!email) return await loginPage(env);
        return new Response(null, { status: 302, headers: { Location: "/toc" } });
      }

      // Public instance information — static content, intentionally no auth.
      if (path === "/onboarding" && method === "GET") {
        return homePage();
      }

      if (path === "/assets/app-icon.jpg" && method === "GET") {
        return appIconAsset();
      }

      // Public reply help — explains the phone reply status colors and how to
      // deliver a saved reply after a session ends. Static, intentionally no auth.
      if (path === "/help/replies" && method === "GET") {
        return replyHelpPage();
      }

      const webMessageMatch = path.match(/^\/messages\/([a-f0-9-]+)$/);
      if (webMessageMatch && method === "GET") {
        const userId = await resolveCallerUserId(request, env);
        if (!userId) return await loginPage(env);
        const message = await env.DB.prepare(
          "SELECT * FROM messages WHERE id = ? AND user_id = ?"
        )
          .bind(webMessageMatch[1], userId)
          .first<MessageDetailRow>();
        if (!message) return new Response("Message not found", { status: 404 });
        const blocks = (await loadMessageBlocks(env, [webMessageMatch[1]])).get(webMessageMatch[1]) ?? [];
        await env.DB.prepare(
          "UPDATE messages SET read = 1, read_at = datetime('now') WHERE id = ? AND user_id = ?"
        )
          .bind(webMessageMatch[1], userId)
          .run();
        return await messageDetailPage(env, message, blocks);
      }

      if (path === "/inbox" && method === "GET") {
        const userId = await resolveCallerUserId(request, env);
        if (!userId) return await loginPage(env);
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
        const conditions: string[] = ["user_id = ?"];
        const binds: (string | number)[] = [userId];
        if (typeFilter) { conditions.push("type = ?"); binds.push(typeFilter); }
        if (projectFilter) { conditions.push("instance_project = ?"); binds.push(projectFilter); }
        if (sourceFilter) { conditions.push("instance_source = ?"); binds.push(sourceFilter); }
        if (unreadOnly) { conditions.push("read = 0"); }
        if (repliedParam === "false") { conditions.push("reply IS NULL"); }
        else if (repliedParam === "true") { conditions.push("reply IS NOT NULL"); }
        if (conditions.length) inboxQuery += " WHERE " + conditions.join(" AND ");
        inboxQuery += " ORDER BY CASE priority WHEN 'urgent' THEN 0 ELSE 1 END, created_at DESC LIMIT ? OFFSET ?";
        binds.push(PAGE + 1, inboxOffset);
        const [result, instanceRow, pendingRow] = await Promise.all([
          env.DB.prepare(inboxQuery).bind(...binds).all(),
          env.DB.prepare("SELECT COUNT(*) as count FROM instances WHERE user_id = ?").bind(userId).first<{ count: number }>(),
          env.DB.prepare("SELECT COUNT(*) as count FROM messages WHERE type = 'question' AND reply IS NULL AND user_id = ?").bind(userId).first<{ count: number }>(),
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
        return inboxPage(messages, { typeFilter, projectFilter, sourceFilter, unreadOnly, repliedFilter: repliedParam || "", offset: inboxOffset, hasMore, instanceCount: instanceRow?.count ?? 0, pendingCount: pendingRow?.count ?? 0 });
      }

      // Documents TOC (session auth required)
      if (path === "/toc" && method === "GET") {
        const userId = await resolveCallerUserId(request, env);
        if (!userId) return await loginPage(env);
        const docs = await env.DB.prepare(
          "SELECT * FROM messages WHERE type = 'document' AND (doc_key IS NOT NULL OR body IS NOT NULL) AND user_id = ? ORDER BY created_at DESC"
        ).bind(userId).all();
        return tocPage(docs.results);
      }
      // Artifacts gallery (session auth required)
      if (path === "/artifacts" && method === "GET") {
        const userId = await resolveCallerUserId(request, env);
        if (!userId) return await loginPage(env);
        const roleParam = url.searchParams.get("role");
        const role = roleParam === "widget" || roleParam === "all" ? roleParam : "page";
        const page = await listArtifacts(env, { userId, limit: 50, role });
        return artifactsPage(page.artifacts.map((a) => serializeArtifact(env, a)), role);
      }
      if (path === "/commute" && method === "GET") {
        const userId = await resolveCallerUserId(request, env);
        if (!userId) return await loginPage(env);
        const briefings = await listCommuteBriefings(env, 25, { userId });
        return commutePage(briefings);
      }

      if (path === "/workspace" && method === "GET") {
        const userId = await resolveCallerUserId(request, env);
        if (!userId) return await loginPage(env);
        const views = await loadWorkspaceTeamViews(env, userId);
        const showBackups = await canListGlobalWorkspaceBackups(env, userId);
        const backups = showBackups ? await listWorkspaceBackups(env, 5) : [];
        return workspacePage({
          teams: views,
          adminBackups: showBackups
            ? { latestAt: backups[0]?.uploaded ?? null, latestKey: backups[0]?.key ?? null, count: backups.length }
            : undefined,
        });
      }

      if (path === "/registry" && method === "GET") {
        const userId = await resolveCallerUserId(request, env);
        if (!userId) return await loginPage(env);
        const instances = await env.DB.prepare(
          "SELECT * FROM instances WHERE user_id = ? ORDER BY last_heartbeat DESC"
        ).bind(userId).all();
        return registryPage(instances.results);
      }

      if (path === "/stats" && method === "GET") {
        const userId = await resolveCallerUserId(request, env);
        if (!userId) return await loginPage(env);
        const [dailyRows, projectRows, modelRows] = await Promise.all([
          env.DB.prepare(
            `SELECT date(created_at) as day, COUNT(*) as count FROM messages
             WHERE user_id = ? AND created_at >= date('now', '-7 days')
             GROUP BY day ORDER BY day DESC`
          ).bind(userId).all<{ day: string; count: number }>(),
          env.DB.prepare(
            `SELECT instance_project as project, COUNT(*) as count FROM messages
             WHERE user_id = ? GROUP BY instance_project ORDER BY count DESC LIMIT 10`
          ).bind(userId).all<{ project: string; count: number }>(),
          env.DB.prepare(
            `SELECT instance_model as model, COUNT(*) as count FROM messages
             WHERE user_id = ? GROUP BY instance_model ORDER BY count DESC LIMIT 10`
          ).bind(userId).all<{ model: string; count: number }>(),
        ]);
        return statsPage({
          messages_per_day: dailyRows.results,
          top_projects: projectRows.results,
          top_models: modelRows.results,
        });
      }

      if (path === "/auth/login-form" && method === "GET") {
        return await loginPage(env, undefined, url.searchParams.get("next") || undefined);
      }

      if (path === "/members-only" && method === "GET") {
        return membersOnlyPage();
      }

      if (path === "/auth/login-form" && method === "POST") {
        const formData = await request.formData();
        const email = formData.get("email") as string;
        const next = (formData.get("next") as string) || undefined;
        if (!email) return await loginPage(env, "Email required");
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
          return await loginPage(env, error, next);
        }
        return new Response(
          `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Check Email</title>
          <style>body{font-family:Inter,sans-serif;background:#FBF7F0;display:flex;
          justify-content:center;align-items:center;min-height:100vh;margin:0;padding:1rem;box-sizing:border-box}
          .card{background:#fff;border-radius:12px;padding:2.5rem;width:100%;max-width:380px;
          text-align:center;box-shadow:0 2px 20px rgba(0,0,0,.06)}
          h2{color:#3D2E2A;margin:0 0 .75rem;font-size:1.4rem}p{color:#6B5550;font-size:1rem;line-height:1.5;margin:0}</style></head>
          <body><div class="card"><h2>Check your email</h2>
          <p>If that email is registered, PidginDocs sent you a login link. It expires in 5 minutes.</p>
          </div></body></html>`,
          { headers: { "Content-Type": "text/html" } }
        );
      }

      if (path === "/auth/logout" && method === "GET") {
        return new Response(null, {
          status: 302,
          headers: {
            Location: "/",
            "Set-Cookie": "session=; Path=/; Max-Age=0",
          },
        });
      }

      return json({ ok: false, error: "not found" }, 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal error";
      return json({ ok: false, error: message }, 500);
    }
  },
  scheduled,
  queue: handleEnhanceQueueBatch,
} satisfies ExportedHandler<Env, EnhanceJob>;

export { json, corsHeaders } from "./utils";
// Durable Object classes must be exported from the Worker entry module.
export { MatrixSyncDO } from "./chat/matrix-sync-do";
