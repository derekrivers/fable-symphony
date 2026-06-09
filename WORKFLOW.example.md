---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: your-project-slug
  required_labels:
    - agent
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Closed
    - Cancelled
    - Canceled
    - Duplicate
    - Done

polling:
  interval_ms: 30000

workspace:
  root: ~/symphony_workspaces

hooks:
  after_create: |
    git clone "$REPO_URL" . 2>/dev/null || true
  before_run: |
    git fetch --all --prune || true
  timeout_ms: 60000

agent:
  max_concurrent_agents: 4
  max_turns: 20
  max_retry_backoff_ms: 300000

claude:
  # The runtime appends flags derived from the fields below at launch time.
  command: claude -p --input-format stream-json --output-format stream-json --verbose
  permission_mode: bypassPermissions
  disallowed_tools:
    - "Bash(rm -rf *)"
  # Expose the linear_graphql client-side tool via Symphony's own MCP server:
  #   mcp_config: ./mcp.json
  # where mcp.json contains:
  #   {"mcpServers":{"linear":{"command":"symphony","args":["mcp-linear","./WORKFLOW.md"]}}}
  # and then allow it:
  #   allowed_tools:
  #     - mcp__linear__linear_graphql
  turn_timeout_ms: 3600000
  read_timeout_ms: 30000
  stall_timeout_ms: 300000

# OPTIONAL observability HTTP server (spec §13.7); CLI --port overrides.
# server:
#   port: 8787
---

You are working on a Linear issue inside a dedicated workspace directory.

Issue: {{ issue.identifier }} — {{ issue.title }}
State: {{ issue.state }}
{% if attempt %}This is retry/continuation attempt {{ attempt }}.{% endif %}

Description:
{{ issue.description }}

Instructions:

1. Read the repository in this workspace and understand the change the issue asks for.
2. Implement the change on a branch named {{ issue.branch_name | default: issue.identifier }}.
3. Run the project's tests and fix failures you introduced.
4. Commit your work, push the branch, and open a pull request.
5. Use the linear_graphql tool (if available) to move the issue to "Human Review"
   and post a comment linking the PR.
6. If you are blocked, post a comment explaining why and leave the issue state unchanged.
