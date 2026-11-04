#!/bin/sh
# Checks the four models with TLC: each .cfg as written (must pass), then each seeded bug
# (must break the rule it names). Usage: docs/models/check.sh [outdir]
# Finds TLC like the statechart skill does (mise), or set TLA2TOOLS and JAVA.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out=${1:-$(mktemp -d)}
mkdir -p "$out"

TLC_TOOL='http:tla2tools[url=https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar,checksum=sha256:936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88]@1.7.4'
JAR=${TLA2TOOLS:-}
[ -n "$JAR" ] || JAR="$(mise where "$TLC_TOOL" 2>/dev/null)/tla2tools.jar"
[ -f "$JAR" ] || JAR="$HOME/.local/share/tla/tla2tools.jar"
[ -f "$JAR" ] || { echo "No tla2tools.jar: run 'mise install \"$TLC_TOOL\"' or set TLA2TOOLS" >&2; exit 1; }
JAVA=${JAVA:-$(mise which java --tool java@temurin-25 2>/dev/null || command -v java)}

tlc() { # model cfg log [workers]  (TLC reads the cfg only from the spec's folder, so both go in $out)
  cp "$here/$1.tla" "$out/"
  [ "$2" = "$out/$(basename "$2")" ] || cp "$2" "$out/"
  (cd "$out" && "$JAVA" -XX:+UseParallelGC -cp "$JAR" tlc2.TLC -workers "${4:-auto}" -cleanup \
    -metadir "$out/states-$(basename "$3" .out)" -config "$(basename "$2")" "$1.tla" > "$3" 2>&1) || true
}
summary() { # log
  states=$(sed -n 's/.* \([0-9]*\) distinct states found.*/\1/p' "$1" | tail -1)
  secs=$(sed -n 's/^Finished in \(.*\) at .*/\1/p' "$1" | tail -1)
  echo "$states states, $secs"
}

fail=0
for m in AccountIsolation PartyInvites Onboarding StreamAccess; do
  log="$out/$m.out"
  tlc "$m" "$here/$m.cfg" "$log"
  if grep -q "No error has been found" "$log"; then echo "PASS  $m: $(summary "$log")"
  else echo "FAIL  $m: see $log"; fail=1; fi
done

# model  bug  rule it must break
while read -r m bug rule; do
  [ -n "$m" ] || continue
  cfg="$out/$m-$bug.cfg"
  kind=INVARIANTS
  [ "$rule" = SeesCurrentTitle ] && kind=PROPERTIES
  # Keep the constants, set the bug, check only the named rule.
  sed -e "s/Bug = \"none\"/Bug = \"$bug\"/" -e '/^INVARIANTS/,$d' "$here/$m.cfg" > "$cfg"
  printf '%s\n  %s\n' "$kind" "$rule" >> "$cfg"
  log="$out/$m-$bug.out"
  tlc "$m" "$cfg" "$log" 1   # one worker: breadth-first, so the trace is a shortest one
  steps=$(grep -c '^State [0-9]*:' "$log" || true)
  if grep -q -e "Invariant $rule is violated" -e "Temporal properties were violated" "$log"; then
    echo "CAUGHT $m $bug -> $rule ($steps-state trace, $(summary "$log"))"
  else echo "MISSED $m $bug -> $rule: see $log"; fail=1; fi
done <<'EOF'
StreamAccess hls_token_only OnlyAllowedReads
StreamAccess warm_any_room OnlyMembersWarm
StreamAccess left_keeps_access OnlyAllowedReads
StreamAccess guest_after_host_left NoGuestWithoutHost
StreamAccess link_without_torbox OthersNeedTorBox
AccountIsolation today_choose_any_profile SessionInOwnAccount
AccountIsolation signout_keeps_sessions SignOutEndsSessions
AccountIsolation skip_pin PinRespected
AccountIsolation pin_keeps_sessions PinRespected
AccountIsolation keys_by_argument KeysIsolated
AccountIsolation today_list_all_profiles ProfileListIsolated
AccountIsolation today_live_lists_all_rooms RoomListIsolated
AccountIsolation live_shows_all_members MemberListIsolated
AccountIsolation today_get_any_room MemberListIsolated
AccountIsolation today_join_without_invite MembersInvitedOrSameAccount
AccountIsolation delete_keeps_sessions DeletedLeavesNothing
AccountIsolation today_delete_keeps_rooms DeletedLeavesNothing
PartyInvites today_join_without_invite MembersInvitedOrSameAccount
PartyInvites end_keeps_link EndedRoomIsEmpty
PartyInvites today_end_keeps_guest_links EndedRoomIsEmpty
PartyInvites today_lists_expired_guests ExpiredGuestNotMember
PartyInvites today_keep_absent_host OneHostPresent
PartyInvites kick_not_enforced KickedStayOut
PartyInvites today_handoff_any_account HostHasTorBox
PartyInvites party_without_torbox HostHasTorBox
PartyInvites guests_miss_updates SeesCurrentTitle
Onboarding route_ignores_tmdb HomeNeedsProfileAndTmdb
Onboarding home_ignores_dead_key HomeNeedsProfileAndTmdb
Onboarding signout_keeps_screen SignedOutSeesLanding
Onboarding stale_torbox_gate NoTorBoxShownUnavailable
Onboarding play_ignores_gate NeverFailsForMissingTorBox
Onboarding torbox_hidden_always TorBoxShownAvailable
Onboarding play_needs_torbox DebridShownPlayable
EOF
echo "TLC output: $out"
exit $fail
