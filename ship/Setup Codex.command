#!/bin/bash
# Sets up translation for WhatsApp Translate:
#   1. installs the Codex CLI if it's missing (official OpenAI installer, no admin rights needed)
#   2. opens your browser so you can sign in to Codex with your ChatGPT account
#   3. closes this window once you're done
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
# the app may still be next to this script, or already moved to Applications
APP=""
for candidate in "$HERE/WhatsApp Translate.app" "/Applications/WhatsApp Translate.app" "$HOME/Applications/WhatsApp Translate.app"; do
  [ -d "$candidate" ] && { APP="$candidate"; break; }
done
ORIG_PATH="$PATH"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

bold()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()    { printf '\033[32m✓\033[0m %s\n' "$*"; }
fail()  {
  printf '\n\033[31m✗ %s\033[0m\n' "$*"
  read -r -p "Press Enter to close this window… " _
  exit 1
}
close_window() {
  # close this Terminal window after the script ends
  osascript -e 'tell application "Terminal" to close (every window whose name contains "Setup Codex")' >/dev/null 2>&1 &
  exit 0
}

clear
bold "WhatsApp Translate · Codex setup"

# Apps shared via zip get a "downloaded from the internet" flag that makes macOS block them.
if [ -n "$APP" ]; then
  xattr -dr com.apple.quarantine "$APP" 2>/dev/null && ok "WhatsApp Translate is allowed to open"
fi

# 1. Codex CLI
if CODEX="$(command -v codex)"; then
  ok "Codex CLI is installed ($CODEX)"
else
  bold "Installing the Codex CLI…"
  # run with the user's own PATH so the installer adds ~/.local/bin to their shell profile
  curl -fsSL https://chatgpt.com/codex/install.sh | PATH="$ORIG_PATH" CODEX_NON_INTERACTIVE=1 sh \
    || fail "The Codex installer failed. Check your internet connection and try again."
  hash -r
  CODEX="$(command -v codex)" || fail "Codex was installed but can't be found. Open a new Terminal window and run this setup again."
  ok "Codex CLI installed"
fi

# 2. Sign in
if "$CODEX" login status >/dev/null 2>&1; then
  ok "Already signed in to Codex"
else
  bold "Opening your browser: sign in with your ChatGPT account…"
  echo "(This window continues by itself once you've signed in.)"
  "$CODEX" login || fail "Sign-in didn't complete. Run this setup again to retry."
  "$CODEX" login status >/dev/null 2>&1 || fail "Sign-in didn't complete. Run this setup again to retry."
  ok "Signed in to Codex"
fi

bold "All set! Opening WhatsApp Translate…"
[ -n "$APP" ] && open "$APP"
sleep 2
close_window
