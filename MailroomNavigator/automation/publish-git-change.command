#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
cd "$REPO_DIR"

timestamp="$(date +%Y%m%d-%H%M)"
changed_files="$(git status --porcelain | sed -E 's/^...//')"

suggest_publish_details() {
  local files="$1"
  local branch="mailroomnavigator-updates-${timestamp}"
  local message="Update Mailroom Navigator"

  if echo "$files" | grep -q 'MailroomNavigator/bot_dashboard_navigator.js'; then
    if git diff -- MailroomNavigator/bot_dashboard_navigator.js | grep -qiE 'dashboard filters|selectedPractices|selectedJobTypes|selectedStatuses|filterGrid'; then
      branch="bot-dashboard-filter-ux-${timestamp}"
      message="Improve bot dashboard filter UX"
    else
      branch="bot-dashboard-navigator-updates-${timestamp}"
      message="Update bot dashboard navigator"
    fi
  fi

  if echo "$files" | grep -q 'MailroomNavigator/COLLEAGUE_INSTALL_GUIDE.md'; then
    if [[ "$branch" == "mailroomnavigator-updates-${timestamp}" ]]; then
      branch="colleague-install-guide-${timestamp}"
      message="Add colleague install guide"
    else
      message="${message} and install guide"
    fi
  fi

  if echo "$files" | grep -q 'MailroomNavigator/automation/publish-git-change.command'; then
    if [[ "$branch" == "mailroomnavigator-updates-${timestamp}" ]]; then
      branch="git-publish-helper-${timestamp}"
      message="Add git publish helper"
    fi
  fi

  printf '%s\n%s\n' "$branch" "$message"
}

suggestions_text="$(suggest_publish_details "$changed_files")"
default_branch="$(printf '%s\n' "$suggestions_text" | sed -n '1p')"
default_message="$(printf '%s\n' "$suggestions_text" | sed -n '2p')"
default_branch="${default_branch:-mailroomnavigator-updates-${timestamp}}"
default_message="${default_message:-Update Mailroom Navigator}"

can_use_gui() {
  command -v osascript >/dev/null 2>&1 && [[ -n "${DISPLAY:-}" || "$(uname -s)" == "Darwin" ]]
}

gui_prompt() {
  local title="$1"
  local prompt="$2"
  local default_value="$3"
  osascript - "$title" "$prompt" "$default_value" <<'APPLESCRIPT'
on run argv
  set dialogTitle to item 1 of argv
  set dialogPrompt to item 2 of argv
  set defaultValue to item 3 of argv
  set answer to display dialog dialogPrompt default answer defaultValue buttons {"Cancel", "Continue"} default button "Continue" cancel button "Cancel" with title dialogTitle
  return text returned of answer
end run
APPLESCRIPT
}

gui_confirm_publish() {
  local branch="$1"
  local message="$2"
  local files="$3"
  osascript - "$branch" "$message" "$files" <<'APPLESCRIPT'
on run argv
  set branchName to item 1 of argv
  set commitMessage to item 2 of argv
  set changedFiles to item 3 of argv
  set dialogText to "Ready to publish these changes:" & return & return & changedFiles & return & return & "Branch:" & return & branchName & return & return & "Commit:" & return & commitMessage
  display dialog dialogText buttons {"Cancel", "Publish"} default button "Publish" cancel button "Cancel" with title "BetterLetter Git Publish"
end run
APPLESCRIPT
}

gui_message() {
  local title="$1"
  local message="$2"
  osascript - "$title" "$message" <<'APPLESCRIPT' >/dev/null 2>&1 || true
on run argv
  display dialog (item 2 of argv) buttons {"OK"} default button "OK" with title (item 1 of argv)
end run
APPLESCRIPT
}

echo "== BetterLetter Git Publish Helper =="
echo "Repo: $REPO_DIR"
echo

current_branch="$(git branch --show-current || true)"
dirty_count="$(git status --porcelain | wc -l | tr -d ' ')"
stash_name=""

echo "Current branch: ${current_branch:-unknown}"
echo "Changed files: $dirty_count"
echo

if [[ "$dirty_count" == "0" ]]; then
  message="No local changes found to publish."
  echo "$message"
  if can_use_gui; then gui_message "BetterLetter Git Publish" "$message"; fi
  exit 0
fi

if can_use_gui; then
  branch_name="$(gui_prompt "BetterLetter Git Publish" "Branch name:" "$default_branch")"
  commit_message="$(gui_prompt "BetterLetter Git Publish" "Commit message:" "$default_message")"
  gui_confirm_publish "$branch_name" "$commit_message" "$changed_files"
else
  read -r -p "New branch name [$default_branch]: " branch_name
  branch_name="${branch_name:-$default_branch}"
  read -r -p "Commit message [$default_message]: " commit_message
  commit_message="${commit_message:-$default_message}"
fi

branch_name="$(echo "$branch_name" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9._\/-]+/-/g; s/^-+//; s/-+$//')"

if [[ -z "$branch_name" || "$branch_name" == "main" ]]; then
  echo "Branch name must not be empty or main."
  exit 1
fi

if git show-ref --verify --quiet "refs/heads/$branch_name"; then
  echo "Local branch already exists: $branch_name"
  exit 1
fi

if [[ "$dirty_count" != "0" ]]; then
  stash_name="mailroom-publish-helper-${timestamp}"
  echo
  echo "Saving current changes temporarily..."
  git stash push -u -m "$stash_name" >/dev/null
fi

echo
echo "Switching to main..."
git switch main

echo "Creating branch: $branch_name"
git switch -c "$branch_name"

if [[ -n "$stash_name" ]]; then
  echo "Restoring your changes onto $branch_name..."
  git stash pop >/dev/null
fi

echo "Adding all changes..."
git add -A

if git diff --cached --quiet; then
  echo "No staged changes to commit."
  git switch main
  exit 1
fi

echo "Committing..."
git commit -m "$commit_message"

echo "Pushing to origin..."
git push -u origin "$branch_name"

echo "Returning to main..."
git switch main

echo
echo "Done."
echo "Created and pushed branch: $branch_name"
echo "Commit message: $commit_message"

if can_use_gui; then
  gui_message "BetterLetter Git Publish" "Done. Created and pushed branch:\n\n$branch_name\n\nCommit:\n$commit_message\n\nReturned to main."
fi
