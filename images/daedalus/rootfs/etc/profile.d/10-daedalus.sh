# daedalus login-shell environment.
# Claude Code is baked at a pinned version in a root-owned tree (/opt/claude),
# so the in-place autoupdater can't write there — disable it to avoid noise.
export DISABLE_AUTOUPDATER=1
