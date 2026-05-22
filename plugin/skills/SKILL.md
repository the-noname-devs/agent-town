---
name: town
description: Check team collaboration status, manage file locks, zones, and communicate with other agents
user-invocable: true
allowed-tools:
  - mcp__agent-town__get_team_status
  - mcp__agent-town__check_file
  - mcp__agent-town__claim_file
  - mcp__agent-town__release_file
  - mcp__agent-town__claim_zone
  - mcp__agent-town__release_zone
  - mcp__agent-town__send_message
  - mcp__agent-town__get_activity
  - mcp__agent-town__get_conflicts
  - mcp__agent-town__get_messages
---

# Agent Town

You have access to the Agent Town collaboration tools. Use them to coordinate with other team members' Claude Code instances.

## Available Actions

1. **Check team status** — Use `get_team_status` to see who is online, their branch, and what files they're editing
2. **Check file safety** — Use `check_file` before editing to check for conflicts, locks, and protected zones
3. **Claim a file** — Use `claim_file` before editing to let others know you're working on it
4. **Release a file** — Use `release_file` when done editing
5. **Protect a zone** — Use `claim_zone` to protect an entire directory from edits by others
6. **Release a zone** — Use `release_zone` to remove zone protection
7. **Check conflicts** — Use `get_conflicts` to see if multiple people are editing the same file
8. **View activity** — Use `get_activity` to see recent file changes across the team
9. **Send a message** — Use `send_message` to communicate with other agents
10. **Read messages** — Use `get_messages` to check for messages from teammates

## Best Practices

- Always check `get_team_status` before starting work on a file
- Use `check_file` before editing a file to verify it's safe
- If another agent is editing the same file, coordinate or work on a different file
- Use `claim_zone` when refactoring an entire directory
- Release files and zones when you're done so others can work on them
