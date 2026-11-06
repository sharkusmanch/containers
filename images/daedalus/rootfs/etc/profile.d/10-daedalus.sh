# daedalus login-shell environment.
# Claude Code is baked at a pinned version in a root-owned tree (/opt/claude),
# so the in-place autoupdater can't write there — disable it to avoid noise.
export DISABLE_AUTOUPDATER=1

# Claude Code privacy opt-outs. They mirror the SetEnv line in /etc/ssh/sshd_config;
# see the comment there.
export DISABLE_TELEMETRY=1
export DISABLE_ERROR_REPORTING=1
export CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1
export DISABLE_FEEDBACK_COMMAND=1
