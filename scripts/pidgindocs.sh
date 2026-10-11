#!/bin/bash
# pidgindocs.sh — PidginDocs API client
# Usage: pidgindocs.sh {send|board|poll|health|check} [args...]
set -euo pipefail

# --- Credentials -----------------------------------------------------------
# Configure the self-hosted Worker URL and API key in the environment.
: "${PIDGINDOCS_URL:=https://pidgindocs.example.workers.dev}"
PIDGINDOCS_API_KEY="${PIDGINDOCS_API_KEY:-}"
PIDGINDOCS_AGENT_KEY="${PIDGINDOCS_AGENT_KEY:-}"
PIDGINDOCS_KEY_SOURCE="${PIDGINDOCS_API_KEY:+environment}"
PIDGINDOCS_KEY_SOURCE="${PIDGINDOCS_KEY_SOURCE:-none}"

# `check`/`health` are diagnostics — let them run and report a missing key
# rather than aborting before they can help the user troubleshoot.
case "${1:-}" in
  check|health|board) : "${PIDGINDOCS_API_KEY:=}" ;;
  *) : "${PIDGINDOCS_API_KEY:?not set — export PIDGINDOCS_API_KEY (create one at ${PIDGINDOCS_URL}/setup)}" ;;
esac

cmd_send() {
  local type="" title="" body="" html="" markdown="" project="" priority="normal" source_url="" json_output=false
  local design_system="" enhance="" instructions=""
  local blocks_file=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --type)          type="$2";       shift 2 ;;
      --title)         title="$2";      shift 2 ;;
      --body)          body="$2";       shift 2 ;;
      --html)          html="$2";       shift 2 ;;
      --markdown)      markdown="$2";   shift 2 ;;
      --markdown-file) markdown="$(cat "$2")"; shift 2 ;;
      --project)       project="$2";    shift 2 ;;
      --priority)      priority="$2";   shift 2 ;;
      --source-url)    source_url="$2"; shift 2 ;;
      --design-system) design_system="$2"; shift 2 ;;
      --enhance)       enhance="$2";       shift 2 ;;
      --instructions)  instructions="$2";  shift 2 ;;
      --blocks-file)   blocks_file="$2";   shift 2 ;;
      --json)          json_output=true; shift ;;
      *) echo "Unknown arg: $1" >&2; exit 1 ;;
    esac
  done

  if [[ -z "$type" || -z "$title" ]]; then
    echo "Usage: pidgindocs.sh send --type <type> --title <title> [--body <body>] [--markdown <md> | --markdown-file <path>] [--html <html>] [--blocks-file <json>] [--project <project>] [--priority normal|urgent] [--source-url <url>] [--design-system <name>] [--enhance none|polish|enrich|research] [--instructions <text>] [--json]" >&2
    exit 1
  fi

  if [[ ( -n "$html" || -n "$markdown" ) && "$type" != "document" ]]; then
    type="document"
  fi
  if [[ -n "$blocks_file" && ( -n "$html" || -n "$markdown" || "$type" == "document" ) ]]; then
    echo "Error: --blocks-file is supported for message, question, and status sends only" >&2
    exit 1
  fi

  # Content precedence: raw html > markdown (server typesets it) > plain body
  local content_field="body"
  local content_value="$body"
  if [[ -n "$html" ]]; then
    content_field="html"
    content_value="$html"
  elif [[ -n "$markdown" ]]; then
    content_field="markdown"
    content_value="$markdown"
  fi

  local session_id="${PIDGINDOCS_SESSION_ID:-${CLAUDE_SESSION_ID:-cli}}"
  local model="${PIDGINDOCS_MODEL:-${CLAUDE_MODEL:-codex}}"
  local instance_source="${PIDGINDOCS_SOURCE:-codex}"
  if [[ -n "${CLAUDE_SESSION_ID:-}" && -z "${PIDGINDOCS_SOURCE:-}" ]]; then
    instance_source="claude-code"
  fi
  local blocks_json="null"
  if [[ -n "$blocks_file" ]]; then
    if [[ ! -f "$blocks_file" ]]; then
      echo "Error: blocks file not found: $blocks_file" >&2
      exit 1
    fi
    blocks_json=$(jq -ce 'if type == "array" then . else error("blocks file must contain a JSON array") end' "$blocks_file")
  fi

  local payload
  payload=$(jq -n \
    --arg type "$type" \
    --arg title "$title" \
    --arg cf "$content_field" \
    --arg cv "$content_value" \
    --arg project "$project" \
    --arg priority "$priority" \
    --arg source_url "$source_url" \
    --arg design_system "$design_system" \
    --arg enhance "$enhance" \
    --arg instructions "$instructions" \
    --arg session_id "$session_id" \
    --arg model "$model" \
    --arg instance_source "$instance_source" \
    --argjson blocks "$blocks_json" \
    '{
      type: $type,
      title: $title,
      ($cf): $cv,
      priority: $priority,
      source_url: (if $source_url != "" then $source_url else null end),
      design_system: (if $design_system != "" then $design_system else null end),
      enhance: (if $enhance != "" then $enhance else null end),
      instructions: (if $instructions != "" then $instructions else null end),
      blocks: $blocks,
      instance: {
        model: $model,
        session_id: $session_id,
        project: $project,
        source: $instance_source
      }
    } | del(.[] | nulls)')

  local response
  response=$(curl -s --max-time 15 -X POST "$PIDGINDOCS_URL/api/messages" \
    -H "Authorization: Bearer $PIDGINDOCS_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$payload")

  local ok msg_id
  ok=$(echo "$response" | jq -r '.ok')
  if [[ "$ok" != "true" ]]; then
    printf "Error: %s\n" "$(echo "$response" | jq -r '.error // "unknown error"')" >&2
    echo "$response"
    return 1
  fi
  msg_id=$(echo "$response" | jq -r '.data.id')
  [[ "$json_output" == false ]] && printf "Sent %s: \"%s\" [%s] — id: %s\n" "$type" "$title" "$priority" "$msg_id" >&2
  echo "$response"
}

cmd_artifact_publish() {
  local html_file="" markdown_file="" title="" description="" favicon="" label=""
  local artifact_id="" source_path="" base_version="" visibility="" role="page"
  local notify="" force=false project="" json_output=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --html-file)     html_file="$2";     shift 2 ;;
      --markdown-file) markdown_file="$2"; shift 2 ;;
      --title)         title="$2";         shift 2 ;;
      --description)   description="$2";   shift 2 ;;
      --favicon)       favicon="$2";       shift 2 ;;
      --label)         label="$2";         shift 2 ;;
      --artifact-id)   artifact_id="$2";   shift 2 ;;
      --source-path)   source_path="$2";   shift 2 ;;
      --base-version)  base_version="$2";  shift 2 ;;
      --visibility)    visibility="$2";    shift 2 ;;
      --role)          role="$2";          shift 2 ;;
      --notify)        notify="$2";        shift 2 ;;
      --force)         force=true;          shift ;;
      --project)       project="$2";       shift 2 ;;
      --json)          json_output=true;    shift ;;
      *) echo "Unknown artifact arg: $1" >&2; exit 1 ;;
    esac
  done

  if [[ ( -z "$html_file" && -z "$markdown_file" ) || ( -n "$html_file" && -n "$markdown_file" ) ]]; then
    echo "Usage: pidgindocs.sh artifact publish (--html-file <path> | --markdown-file <path>) --favicon <emoji> [--title <title>] [--role page|widget] [--notify true|false] [--json]" >&2
    exit 1
  fi
  local content_file="$html_file"
  local content_kind="html"
  if [[ -n "$markdown_file" ]]; then
    content_file="$markdown_file"
    content_kind="markdown"
  fi
  if [[ ! -f "$content_file" ]]; then
    echo "Error: artifact source file not found: $content_file" >&2
    exit 1
  fi
  if [[ "$role" != "page" && "$role" != "widget" ]]; then
    echo "Error: --role must be page or widget" >&2
    exit 1
  fi
  if [[ -n "$notify" && "$notify" != "true" && "$notify" != "false" ]]; then
    echo "Error: --notify must be true or false" >&2
    exit 1
  fi

  local session_id="${PIDGINDOCS_SESSION_ID:-${CLAUDE_SESSION_ID:-cli}}"
  local payload
  payload=$(jq -n \
    --rawfile content "$content_file" \
    --arg kind "$content_kind" \
    --arg title "$title" \
    --arg description "$description" \
    --arg favicon "$favicon" \
    --arg label "$label" \
    --arg artifact_id "$artifact_id" \
    --arg source_path "${source_path:-$content_file}" \
    --arg base_version "$base_version" \
    --arg visibility "$visibility" \
    --arg role "$role" \
    --arg notify "$notify" \
    --argjson force "$force" \
    --arg session_id "$session_id" \
    --arg project "${project:-$(basename "$(pwd)")}" \
    '{
      title: (if $title != "" then $title else null end),
      description: (if $description != "" then $description else null end),
      favicon: (if $favicon != "" then $favicon else null end),
      label: (if $label != "" then $label else null end),
      artifact_id: (if $artifact_id != "" then $artifact_id else null end),
      source_path: $source_path,
      base_version: (if $base_version != "" then ($base_version | tonumber) else null end),
      visibility: (if $visibility != "" then $visibility else null end),
      role: $role,
      notify: (if $notify == "true" then true elif $notify == "false" then false else null end),
      force: $force,
      instance: {session_id: $session_id, project: $project}
    } + (if $kind == "html" then {html: $content} else {markdown: $content} end)
      | del(.[] | nulls)')

  local response
  response=$(curl -s --max-time 30 -X POST "$PIDGINDOCS_URL/api/artifacts" \
    -H "Authorization: Bearer $PIDGINDOCS_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$payload")
  local ok
  ok=$(echo "$response" | jq -r '.ok')
  if [[ "$ok" != "true" ]]; then
    printf "Error: %s\n" "$(echo "$response" | jq -r '.error // "unknown error"')" >&2
    echo "$response"
    return 1
  fi
  if [[ "$json_output" == false ]]; then
    printf "Published artifact: %s v%s — %s\n" \
      "$(echo "$response" | jq -r '.data.title')" \
      "$(echo "$response" | jq -r '.data.version')" \
      "$(echo "$response" | jq -r '.data.url')" >&2
  fi
  echo "$response"
}

cmd_artifact() {
  local action="${1:-}"
  shift || true
  case "$action" in
    publish) cmd_artifact_publish "$@" ;;
    *) echo "Usage: pidgindocs.sh artifact publish ..." >&2; exit 1 ;;
  esac
}

cmd_board_read() {
  local project_id="" after="0" limit="40" human=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --project-id) project_id="$2"; shift 2 ;;
      --after)      after="$2";      shift 2 ;;
      --limit)      limit="$2";      shift 2 ;;
      --human)      human=true;      shift ;;
      *) echo "Unknown board read arg: $1" >&2; exit 1 ;;
    esac
  done
  if [[ -z "$project_id" ]]; then
    echo "Usage: pidgindocs.sh board read --project-id <id> [--after <cursor>] [--limit <1-100>] [--human]" >&2
    exit 1
  fi
  : "${PIDGINDOCS_AGENT_KEY:?not set — export the one-time project-scoped PIDGINDOCS_AGENT_KEY}"

  local response
  response=$(curl -sS --max-time 15 \
    "$PIDGINDOCS_URL/api/agent-board/$project_id?after=$after&limit=$limit&protocol=pb2" \
    -H "Authorization: Agent $PIDGINDOCS_AGENT_KEY" \
    -H "Accept: application/vnd.pidgin.board+json")
  if ! echo "$response" | jq -e 'type == "array" and (.[0] == "pb1" or .[0] == "pb2")' >/dev/null 2>&1; then
    printf "Error: %s\n" "$(echo "$response" | jq -r '.error // "invalid board response"' 2>/dev/null || echo "invalid board response")" >&2
    echo "$response"
    return 1
  fi
  if [[ "$human" == false ]]; then
    echo "$response"
    return 0
  fi
  echo "$response" | jq -r '
    . as $page |
    ($page[3][]? | . as $row |
      ({s:"status",c:"claim",h:"handoff",d:"decision",b:"blocker",n:"note"}[$row[3]]) as $kind |
      ($page[2][$row[2]] | if $page[0] == "pb2" then map(if . == 0 then "unknown" else . end) else . end) as $actor |
      "[\($row[0])] \(if $page[0] == "pb2" then $actor[2] else $actor end) · \($kind) · \($row[4])\n" +
      (if $page[0] == "pb2" then
        "Agent: \($actor[0]) · Key owner: \($actor[3]) · Session: \($actor[5]) (\($actor[4])) · Model: \($actor[6]) / \($actor[7]) · Origin: \($actor[8]) / \($actor[9])\n"
       else "" end) + $row[5] +
      (if $row[6] == 0 then "" else "\nReference: \($row[6])" end)
    ) // "No agent board activity."'
}

cmd_board_post() {
  local project_id="" kind="" topic="" body="" reference="" client_id=""
  local session_id="${PIDGINDOCS_SESSION_ID:-${CODEX_THREAD_ID:-${CLAUDE_SESSION_ID:-}}}"
  local session_name="${PIDGINDOCS_SESSION_NAME:-}" model="${PIDGINDOCS_MODEL:-}" model_version="${PIDGINDOCS_MODEL_VERSION:-}"
  local origin="${PIDGINDOCS_ORIGIN:-}" origin_version="${PIDGINDOCS_ORIGIN_VERSION:-}"
  if [[ -z "$origin" && -n "${CODEX_THREAD_ID:-}" ]]; then origin="codex"; fi
  if [[ -z "$origin" && -n "${CLAUDE_SESSION_ID:-}" ]]; then origin="claude-code"; fi
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --project-id) project_id="$2"; shift 2 ;;
      --kind)       kind="$2";       shift 2 ;;
      --topic)      topic="$2";      shift 2 ;;
      --body)       body="$2";       shift 2 ;;
      --ref)        reference="$2";  shift 2 ;;
      --client-id)  client_id="$2";  shift 2 ;;
      --session-id) session_id="$2"; shift 2 ;;
      --session-name) session_name="$2"; shift 2 ;;
      --model) model="$2"; shift 2 ;;
      --model-version) model_version="$2"; shift 2 ;;
      --origin) origin="$2"; shift 2 ;;
      --origin-version) origin_version="$2"; shift 2 ;;
      *) echo "Unknown board post arg: $1" >&2; exit 1 ;;
    esac
  done
  if [[ -z "$project_id" || -z "$kind" || -z "$topic" || -z "$body" ]]; then
    echo "Usage: pidgindocs.sh board post --project-id <id> --kind s|c|h|d|b|n --topic <text> --body <text> [--ref <path-or-url>] [--client-id <id>] [--session-id <id> --origin <client> --session-name <name> --model <model> --model-version <version> --origin-version <version>]" >&2
    exit 1
  fi
  case "$kind" in s|c|h|d|b|n) ;; *) echo "Error: --kind must be s, c, h, d, b, or n" >&2; exit 1 ;; esac
  : "${PIDGINDOCS_AGENT_KEY:?not set — export the one-time project-scoped PIDGINDOCS_AGENT_KEY}"
  if [[ -n "$session_id$session_name$model$model_version$origin$origin_version" && ( -z "$session_id" || -z "$origin" ) ]]; then
    echo "Error: session metadata requires both --session-id and --origin (or PIDGINDOCS_SESSION_ID and PIDGINDOCS_ORIGIN)" >&2
    return 1
  fi
  client_id="${client_id:-pidgin-$(date +%s)-$$-$RANDOM}"

  local payload response
  payload=$(jq -cn \
    --arg kind "$kind" --arg topic "$topic" --arg body "$body" --arg ref "$reference" \
    --arg session_id "$session_id" --arg session_name "$session_name" --arg model "$model" \
    --arg model_version "$model_version" --arg origin "$origin" --arg origin_version "$origin_version" \
    '[$kind,$topic,$body,(if $ref == "" then 0 else $ref end)] +
      (if $session_id == "" then [] else [{session_id:$session_id,session_name:$session_name,
        model:$model,model_version:$model_version,origin:$origin,origin_version:$origin_version}] end)')
  response=$(curl -sS --max-time 15 -X POST "$PIDGINDOCS_URL/api/agent-board/$project_id" \
    -H "Authorization: Agent $PIDGINDOCS_AGENT_KEY" \
    -H "Idempotency-Key: $client_id" \
    -H "Content-Type: application/json" \
    -d "$payload")
  if ! echo "$response" | jq -e 'type == "array" and length == 3' >/dev/null 2>&1; then
    printf "Error: %s\n" "$(echo "$response" | jq -r '.error // "invalid board response"' 2>/dev/null || echo "invalid board response")" >&2
    echo "$response"
    return 1
  fi
  echo "$response"
}

cmd_board_members() {
  local project_id=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --project-id) project_id="$2"; shift 2 ;;
      *) echo "Unknown board members arg: $1" >&2; return 1 ;;
    esac
  done
  : "${project_id:?Usage: pidgindocs.sh board members --project-id <id>}"
  : "${PIDGINDOCS_AGENT_KEY:?not set — export the project-scoped PIDGINDOCS_AGENT_KEY}"
  local response
  response=$(curl -sS --max-time 15 "$PIDGINDOCS_URL/api/agent-board/$project_id?format=members" -H "Authorization: Agent $PIDGINDOCS_AGENT_KEY")
  echo "$response"
  echo "$response" | jq -e '.ok == true' >/dev/null
}

cmd_board() {
  local action="${1:-}"
  shift || true
  case "$action" in
    read) cmd_board_read "$@" ;;
    post) cmd_board_post "$@" ;;
    members) cmd_board_members "$@" ;;
    *) echo "Usage: pidgindocs.sh board {read|post|members} ..." >&2; exit 1 ;;
  esac
}

cmd_poll() {
  local msg_id="${1:?Usage: pidgindocs.sh poll <message-id> [--timeout 300] [--interval 5] [--quiet]}"
  shift
  local timeout=300
  local interval=5
  local elapsed=0
  local quiet=false

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --timeout)  timeout="$2";   shift 2 ;;
      --interval) interval="$2";  shift 2 ;;
      --quiet)    quiet=true;     shift ;;
      *) shift ;;
    esac
  done

  [[ "$quiet" == false ]] && printf "Waiting for reply to %s " "$msg_id" >&2

  while [[ $elapsed -lt $timeout ]]; do
    local reply
    reply=$(curl -s --max-time 10 "$PIDGINDOCS_URL/api/replies/$msg_id" \
      -H "Authorization: Bearer $PIDGINDOCS_API_KEY" || echo "")

    local reply_text
    reply_text=$(echo "$reply" | jq -r '.data.reply // empty')

    if [[ -n "$reply_text" ]]; then
      [[ "$quiet" == false ]] && printf "\n" >&2
      echo "$reply"
      return 0
    fi

    [[ "$quiet" == false ]] && printf "." >&2
    sleep "$interval"
    elapsed=$((elapsed + interval))
  done

  [[ "$quiet" == false ]] && printf "\n" >&2
  echo "{\"ok\":false,\"error\":\"poll timeout after ${timeout}s\"}" >&2
  return 1
}

cmd_heartbeat() {
  local instance_id="${1:?Usage: pidgindocs.sh heartbeat <instance-id> [--working-on <text>]}"
  shift
  local working_on=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --working-on) working_on="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  local payload
  payload=$(jq -n --arg wo "$working_on" '{"working_on": (if $wo != "" then $wo else null end)}')

  curl -s -X POST "$PIDGINDOCS_URL/api/register/$instance_id/heartbeat" \
    -H "Authorization: Bearer $PIDGINDOCS_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$payload"
}

cmd_register() {
  local instance_id="" model="${PIDGINDOCS_MODEL:-${CLAUDE_MODEL:-codex}}" project="" source="${PIDGINDOCS_SOURCE:-codex}" working_on=""
  if [[ -n "${CLAUDE_SESSION_ID:-}" && -z "${PIDGINDOCS_SOURCE:-}" ]]; then
    source="claude-code"
  fi
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --instance-id)  instance_id="$2";  shift 2 ;;
      --model)        model="$2";        shift 2 ;;
      --project)      project="$2";      shift 2 ;;
      --source)       source="$2";       shift 2 ;;
      --working-on)   working_on="$2";   shift 2 ;;
      *) echo "Unknown arg: $1" >&2; exit 1 ;;
    esac
  done
  instance_id="${instance_id:-${PIDGINDOCS_SESSION_ID:-${CLAUDE_SESSION_ID:-cli-$$}}}"
  project="${project:-$(basename "$(pwd)")}"

  local payload
  payload=$(jq -n \
    --arg id "$instance_id" --arg model "$model" \
    --arg project "$project" --arg source "$source" \
    --arg wo "$working_on" \
    '{instance_id:$id,model:$model,project:$project,source:$source,
      working_on:(if $wo!="" then $wo else null end)} | del(.[]|nulls)')

  curl -s -X POST "$PIDGINDOCS_URL/api/register" \
    -H "Authorization: Bearer $PIDGINDOCS_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$payload"
}

cmd_deregister() {
  local instance_id="${1:-${PIDGINDOCS_SESSION_ID:-${CLAUDE_SESSION_ID:-}}}"
  if [[ -z "$instance_id" ]]; then
    echo "Usage: pidgindocs.sh deregister <instance-id>" >&2; exit 1
  fi
  curl -s -X DELETE "$PIDGINDOCS_URL/api/register/$instance_id" \
    -H "Authorization: Bearer $PIDGINDOCS_API_KEY"
}

cmd_health() {
  curl -s "$PIDGINDOCS_URL/health" \
    -H "Authorization: Bearer $PIDGINDOCS_API_KEY"
}

cmd_check() {
  local status=0
  echo "--- Environment ---"
  [[ -n "${PIDGINDOCS_URL:-}" ]]     && echo "PIDGINDOCS_URL: set"     || { echo "PIDGINDOCS_URL: NOT SET";     status=1; }
  [[ -n "${PIDGINDOCS_API_KEY:-}" ]] && echo "PIDGINDOCS_API_KEY: set" || { echo "PIDGINDOCS_API_KEY: NOT SET"; status=1; }
  echo "Credential source: ${PIDGINDOCS_KEY_SOURCE:-environment}"

  echo "--- Dependencies ---"
  command -v curl >/dev/null && echo "curl: ok" || { echo "curl: MISSING"; status=1; }
  command -v jq   >/dev/null && echo "jq: ok"   || { echo "jq: MISSING";   status=1; }

  echo "--- Server ---"
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" "$PIDGINDOCS_URL/health" 2>/dev/null || echo "000")
  [[ "$code" == "200" ]] && echo "Server: healthy" || { echo "Server: error (HTTP $code)"; status=1; }

  if [[ "$status" -eq 0 && -n "${PIDGINDOCS_API_KEY:-}" ]]; then
    echo "--- Status ---"
    local api_status
    api_status=$(curl -s "$PIDGINDOCS_URL/api/status" \
      -H "Authorization: Bearer $PIDGINDOCS_API_KEY" 2>/dev/null || echo "{}")
    local msg_count unread_count urgent_unread instance_count live_instances apns
    msg_count=$(echo "$api_status" | jq -r '.data.message_count // "?"')
    unread_count=$(echo "$api_status" | jq -r '.data.unread_count // "?"')
    urgent_unread=$(echo "$api_status" | jq -r '.data.urgent_unread // "?"')
    instance_count=$(echo "$api_status" | jq -r '.data.instance_count // "?"')
    live_instances=$(echo "$api_status" | jq -r '.data.live_instance_count // "?"')
    apns=$(echo "$api_status" | jq -r '.data.apns_configured // false')
    echo "Messages: $msg_count total  $unread_count unread  $urgent_unread urgent"
    echo "Instances: $instance_count registered  $live_instances live  APNs: $apns"
  fi

  return $status
}

cmd_ask() {
  # Sends a question and immediately polls until Ashley replies.
  # Usage: pidgindocs.sh ask --title "..." [--body "..."] [--timeout 300] [--project "..."] [--priority normal|urgent]
  local title="" body="" project="" timeout=300 source_url="" priority="urgent"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --title)      title="$2";      shift 2 ;;
      --body)       body="$2";       shift 2 ;;
      --project)    project="$2";    shift 2 ;;
      --timeout)    timeout="$2";    shift 2 ;;
      --priority)   priority="$2";   shift 2 ;;
      --source-url) source_url="$2"; shift 2 ;;
      *) echo "Unknown arg: $1" >&2; exit 1 ;;
    esac
  done

  if [[ -z "$title" ]]; then
    echo "Usage: pidgindocs.sh ask --title <question> [--body <body>] [--project <project>] [--priority urgent|normal] [--timeout 300]" >&2
    exit 1
  fi

  local send_args=(--type question --title "$title" --priority "$priority")
  [[ -n "$body" ]]       && send_args+=(--body "$body")
  [[ -n "$project" ]]    && send_args+=(--project "$project")
  [[ -n "$source_url" ]] && send_args+=(--source-url "$source_url")

  local send_result
  send_result=$(cmd_send "${send_args[@]}")
  local msg_id
  msg_id=$(echo "$send_result" | jq -r '.data.id // empty')

  if [[ -z "$msg_id" ]]; then
    echo "Failed to send question:" >&2
    echo "$send_result" >&2
    exit 1
  fi

  echo "Sent question $msg_id — waiting for reply..." >&2
  cmd_poll "$msg_id" --timeout "$timeout" | jq -r '.data.reply // "No reply in response"'
}

cmd_count() {
  # Quick count of messages: total, unread, unanswered questions
  local result
  result=$(curl -s "$PIDGINDOCS_URL/api/messages/count" \
    -H "Authorization: Bearer $PIDGINDOCS_API_KEY")
  local ok total unread unanswered
  ok=$(echo "$result" | jq -r '.ok')
  if [[ "$ok" != "true" ]]; then
    echo "Error: $(echo "$result" | jq -r '.error // "unknown"')" >&2
    return 1
  fi
  total=$(echo "$result" | jq -r '.data.total')
  unread=$(echo "$result" | jq -r '.data.unread')
  unanswered=$(echo "$result" | jq -r '.data.unanswered_questions')
  printf "Messages: %s total  %s unread  %s unanswered questions\n" "$total" "$unread" "$unanswered"
}

cmd_stats() {
  local result
  result=$(curl -s "$PIDGINDOCS_URL/api/stats" \
    -H "Authorization: Bearer $PIDGINDOCS_API_KEY")
  local ok
  ok=$(echo "$result" | jq -r '.ok')
  if [[ "$ok" != "true" ]]; then
    echo "Error: $(echo "$result" | jq -r '.error // "unknown"')" >&2
    return 1
  fi
  echo "--- Messages per day (past 7d) ---"
  echo "$result" | jq -r '.data.messages_per_day[] | "\(.day)  \(.count)"'
  echo "--- Top projects ---"
  echo "$result" | jq -r '.data.top_projects[] | "\(.project)  \(.count)"'
  echo "--- Top models ---"
  echo "$result" | jq -r '.data.top_models[] | "\(.model)  \(.count)"'
}

cmd_instances() {
  local live_only=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --live) live_only=true; shift ;;
      *) shift ;;
    esac
  done

  local endpoint="$PIDGINDOCS_URL/api/registry"
  [[ "$live_only" == true ]] && endpoint="$PIDGINDOCS_URL/api/instances/live"

  local result
  result=$(curl -s "$endpoint" -H "Authorization: Bearer $PIDGINDOCS_API_KEY")
  local ok
  ok=$(echo "$result" | jq -r '.ok')
  if [[ "$ok" != "true" ]]; then
    echo "Error: $(echo "$result" | jq -r '.error // "unknown"')" >&2
    return 1
  fi
  echo "$result" | jq -r '.data[] | "\(.status)\t\(.instance_id[0:12])\t\(.model)\t\(.project)\t\(.working_on // "—")"'
}

cmd_read() {
  local message_id="${1:-}"
  local mark_unread=false
  [[ "${2:-}" == "--unread" ]] && mark_unread=true
  if [[ -z "$message_id" ]]; then
    echo "Usage: pidgindocs.sh read <message_id> [--unread]" >&2
    return 1
  fi
  local body
  $mark_unread && body='{"read":false}' || body='{"read":true}'
  local result
  result=$(curl -s -X PATCH "$PIDGINDOCS_URL/api/messages/$message_id/read" \
    -H "Authorization: Bearer $PIDGINDOCS_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$body")
  local ok
  ok=$(echo "$result" | jq -r '.ok')
  if [[ "$ok" != "true" ]]; then
    echo "Error: $(echo "$result" | jq -r '.error // "unknown"')" >&2
    return 1
  fi
  $mark_unread && echo "Marked $message_id as unread." || echo "Marked $message_id as read."
}

cmd_priority() {
  local message_id="${1:-}"
  local new_priority="${2:-}"
  if [[ -z "$message_id" ]]; then
    echo "Usage: pidgindocs.sh priority <message_id> [urgent|normal]" >&2
    return 1
  fi
  if [[ -z "$new_priority" ]]; then
    # Read current priority
    local result
    result=$(curl -s "$PIDGINDOCS_URL/api/messages/$message_id" \
      -H "Authorization: Bearer $PIDGINDOCS_API_KEY")
    local ok
    ok=$(echo "$result" | jq -r '.ok')
    if [[ "$ok" != "true" ]]; then
      echo "Error: $(echo "$result" | jq -r '.error // "unknown"')" >&2
      return 1
    fi
    echo "$(echo "$result" | jq -r '.data.priority')"
  else
    # Set priority
    local body
    body=$(jq -nc --arg p "$new_priority" '{"priority":$p}')
    local result
    result=$(curl -s -X PATCH "$PIDGINDOCS_URL/api/messages/$message_id/priority" \
      -H "Authorization: Bearer $PIDGINDOCS_API_KEY" \
      -H "Content-Type: application/json" \
      -d "$body")
    local ok
    ok=$(echo "$result" | jq -r '.ok')
    if [[ "$ok" != "true" ]]; then
      echo "Error: $(echo "$result" | jq -r '.error // "unknown"')" >&2
      return 1
    fi
    echo "Priority set to $new_priority for message $message_id"
  fi
}

cmd_urgent() {
  local result
  result=$(curl -s "$PIDGINDOCS_URL/api/messages?priority=urgent&unread=true&limit=25" \
    -H "Authorization: Bearer $PIDGINDOCS_API_KEY")
  local ok
  ok=$(echo "$result" | jq -r '.ok')
  if [[ "$ok" != "true" ]]; then
    echo "Error: $(echo "$result" | jq -r '.error // "unknown"')" >&2
    return 1
  fi
  local count
  count=$(echo "$result" | jq '.data | length')
  if [[ "$count" -eq 0 ]]; then
    echo "No unread urgent messages."
    return 0
  fi
  echo "$count unread urgent message(s):"
  echo "$result" | jq -r '.data[] | "  [\(.id[0:8])] [\(.type)] \(.title) (\(.created_at[0:16]))"'
}

cmd_mark_all_read() {
  local result
  result=$(curl -s -X POST "$PIDGINDOCS_URL/api/messages/mark-all-read" \
    -H "Authorization: Bearer $PIDGINDOCS_API_KEY")
  local ok
  ok=$(echo "$result" | jq -r '.ok')
  if [[ "$ok" != "true" ]]; then
    echo "Error: $(echo "$result" | jq -r '.error // "unknown"')" >&2
    return 1
  fi
  local n
  n=$(echo "$result" | jq -r '.data.marked_read // 0')
  echo "Marked $n message(s) as read."
}

cmd_pending() {
  local result
  result=$(curl -s "$PIDGINDOCS_URL/api/messages?type=question&replied=false&limit=25&sort=oldest" \
    -H "Authorization: Bearer $PIDGINDOCS_API_KEY")
  local ok
  ok=$(echo "$result" | jq -r '.ok')
  if [[ "$ok" != "true" ]]; then
    echo "Error: $(echo "$result" | jq -r '.error // "unknown"')" >&2
    return 1
  fi
  local count
  count=$(echo "$result" | jq '.data | length')
  if [[ "$count" -eq 0 ]]; then
    echo "No pending questions."
    return 0
  fi
  echo "$count pending question(s):"
  echo "$result" | jq -r '.data[] | "  [\(.id[0:8])] \(.title) (\(.created_at[0:16]))"'
}

cmd_search() {
  local query="${1:-}"
  if [[ -z "$query" ]]; then
    echo "Usage: pidgindocs.sh search <query>" >&2
    return 1
  fi
  local encoded_q
  encoded_q=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$query" 2>/dev/null || printf '%s' "$query" | sed 's/ /%20/g')
  local result
  result=$(curl -s "$PIDGINDOCS_URL/api/messages?q=${encoded_q}&limit=20" \
    -H "Authorization: Bearer $PIDGINDOCS_API_KEY")
  local ok
  ok=$(echo "$result" | jq -r '.ok')
  if [[ "$ok" != "true" ]]; then
    echo "Error: $(echo "$result" | jq -r '.error // "unknown"')" >&2
    return 1
  fi
  local count
  count=$(echo "$result" | jq '.data | length')
  echo "Found $count message(s) matching \"$query\":"
  echo "$result" | jq -r '.data[] | "[\(.type)] \(.title) (\(.created_at[0:10]))"'
}

cmd_reply() {
  local message_id="${1:-}"
  local reply_text="${2:-}"
  if [[ -z "$message_id" || -z "$reply_text" ]]; then
    echo "Usage: pidgindocs.sh reply <message_id> <reply_text>" >&2
    return 1
  fi
  local body
  body=$(jq -nc --arg id "$message_id" --arg r "$reply_text" '{"message_id":$id,"reply":$r}')
  local result
  result=$(curl -s -X POST "$PIDGINDOCS_URL/api/reply" \
    -H "Authorization: Bearer $PIDGINDOCS_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$body")
  local ok
  ok=$(echo "$result" | jq -r '.ok')
  if [[ "$ok" != "true" ]]; then
    echo "Error: $(echo "$result" | jq -r '.error // "unknown"')" >&2
    return 1
  fi
  echo "Reply posted to message $message_id"
}

case "${1:-}" in
  send)       shift; cmd_send "$@" ;;
  board)      shift; cmd_board "$@" ;;
  artifact)   shift; cmd_artifact "$@" ;;
  ask)        shift; cmd_ask "$@" ;;
  poll)       shift; cmd_poll "$@" ;;
  reply)      shift; cmd_reply "$@" ;;
  pending)       cmd_pending ;;
  urgent)        cmd_urgent ;;
  read)          shift; cmd_read "$@" ;;
  priority)      shift; cmd_priority "$@" ;;
  mark-all-read) cmd_mark_all_read ;;
  search)     shift; cmd_search "$@" ;;
  count)      cmd_count ;;
  stats)      cmd_stats ;;
  instances)  shift; cmd_instances "$@" ;;
  heartbeat)  shift; cmd_heartbeat "$@" ;;
  register)   shift; cmd_register "$@" ;;
  deregister) shift; cmd_deregister "$@" ;;
  health)     cmd_health ;;
  check)      cmd_check ;;
  *)          echo "Usage: pidgindocs.sh {send|board|artifact|ask|poll|reply|pending|urgent|read|priority|search|mark-all-read|count|stats|instances|heartbeat|register|deregister|health|check}" >&2; exit 1 ;;
esac
