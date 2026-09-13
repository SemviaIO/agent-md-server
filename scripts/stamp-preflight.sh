#!/usr/bin/env bash
#
# Stamp `.preflight-ok` with the commit the preceding preflight gates
# validated.
#
# Those gates run against the *working tree*, but the sentinel names a commit,
# and the push guard reads it as "this exact HEAD passed". Those two only agree
# when the tree is clean. On a dirty tree the gates may have passed on content
# that is not in HEAD — or that will never be pushed at all, in the case of an
# untracked file — so a stamp would vouch for something nobody checked.
#
# A dirty tree is not a preflight failure, though: the gates really did pass on
# what was there. It simply does not earn a stamp, so this exits 0 either way
# and preflight's own exit status is left to speak for the gates.
set -euo pipefail

dirty=$(git status --porcelain)

if [[ -n "$dirty" ]]; then
  {
    echo "preflight: gates passed, but the working tree is dirty — .preflight-ok not stamped."
    echo "$dirty" | sed 's/^/  /'
    echo "Commit (or clean) these and re-run preflight to stamp the sentinel."
  } >&2
  exit 0
fi

sha=$(git rev-parse HEAD)
printf '%s\n' "$sha" > .preflight-ok
echo "preflight: stamped .preflight-ok = $sha"
