# Shared by pre-commit and pre-push. Sourced, never run on its own.
#
#   hook_begin <name>     waits for the lock, then makes the run folder $hook_dir and
#                         points TMPDIR into it. Call it from inside the repository.
#   hook_run <command>    runs one step so that a signal, or git going away, stops
#                         everything the step started.
#
# One hook run at a time per clone, across all its worktrees. A run installs and tests
# on every core, and several Sessions committing in the same minute stacked until the
# suites that wait on a real server failed on load alone. The lock is a flock on a
# file in the shared git folder. The kernel drops it when this shell is gone, however
# it went, so a crashed or killed run can never leave a lock behind.
#
# Everything a run writes lives in its run folder: the snapshot, and through TMPDIR
# every temp folder a test forgets to remove. One rm at the end takes all of it.

hook_begin() {
  hook_name=$1
  hook_caller=$PPID
  hook_dir=
  hook_child=
  hook_group=
  hook_watch=
  hook_root=${TMPDIR:-/tmp}
  hook_root=${hook_root%/}/manor-hooks
  mkdir -p "$hook_root"
  hook_lock
  hook_sweep
  trap hook_end 0
  trap 'exit 1' 1 2 3 13 15
  hook_dir=$(mktemp -d "$hook_root/$hook_name.XXXXXX")
  echo $$ > "$hook_dir/pid"
  mkdir "$hook_dir/tmp"
  TMPDIR=$hook_dir/tmp
  export TMPDIR
}

# True once the process that started this hook is gone. Manor stops a git that takes
# too long, and the hook would otherwise wait or test on for nobody.
hook_caller_gone() {
  hook_parent=$(ps -o ppid= -p $$ 2>/dev/null | tr -d ' ') || return 1
  [ -n "$hook_parent" ] && [ "$hook_parent" != "$hook_caller" ]
}

hook_lock() {
  if ! command -v perl >/dev/null 2>&1; then
    echo "$hook_name: perl not found, so this run does not wait for other hook runs." >&2
    return 0
  fi
  hook_lock_file=$(cd "$(git rev-parse --git-common-dir)" && pwd)/manor-hook.lock
  hook_lock_wait=${MANOR_HOOK_LOCK_WAIT:-600}
  hook_waited=0
  exec 9>>"$hook_lock_file"
  until perl -e 'use Fcntl qw(:flock); open(my $lock, ">&=", 9) or exit 2; exit(flock($lock, LOCK_EX | LOCK_NB) ? 0 : 1)'; do
    if [ "$hook_waited" -eq 0 ]; then
      echo "$hook_name: waiting for another hook run ($(cat "$hook_lock_file" 2>/dev/null))." >&2
    fi
    if hook_caller_gone; then exit 1; fi
    if [ "$hook_waited" -ge "$hook_lock_wait" ]; then
      echo "$hook_name: another hook run ($(cat "$hook_lock_file" 2>/dev/null)) still holds the lock after $hook_lock_wait seconds. Nothing was tested. Retry when it is done; do not bypass the hook." >&2
      exit 1
    fi
    sleep 2 9>&-
    hook_waited=$((hook_waited + 2))
  done
  echo "$hook_name, pid $$, in $(pwd), since $(date '+%H:%M:%S')" > "$hook_lock_file"
}

# A run that was killed outright could not clean up. Its folder names a pid that is gone.
hook_sweep() {
  for hook_stale in "$hook_root"/*; do
    [ -d "$hook_stale" ] || continue
    hook_owner=$(cat "$hook_stale/pid" 2>/dev/null) || hook_owner=
    if [ -n "$hook_owner" ]; then
      if kill -0 "$hook_owner" 2>/dev/null; then continue; fi
    elif [ -z "$(find "$hook_stale" -maxdepth 0 -mmin +5 2>/dev/null)" ]; then
      continue
    fi
    rm -rf "$hook_stale"
  done
}

# The step gets its own process group, so the whole tree under it (pnpm, vitest, its
# workers, the servers the tests start) can be stopped with one signal. Descriptor 9
# is the lock: no child may inherit it, or a leftover child would keep the lock.
hook_run() {
  if command -v perl >/dev/null 2>&1; then
    perl -e 'setpgrp(0, 0); exec { $ARGV[0] } @ARGV; exit 127' "$@" 9>&- &
  else
    "$@" 9>&- &
  fi
  hook_child=$!
  hook_group=$hook_child
  ( while kill -0 "$hook_child" 2>/dev/null && kill -0 $$ 2>/dev/null && ! hook_caller_gone; do sleep 2; done
    kill -TERM -- "-$hook_child" 2>/dev/null || kill -TERM "$hook_child" 2>/dev/null || true
    if ! kill -0 $$ 2>/dev/null; then
      # This shell was killed outright: finish what its exit trap would have done.
      sleep 5
      kill -KILL -- "-$hook_child" 2>/dev/null || true
      rm -rf "$hook_dir"
    fi
  ) </dev/null >/dev/null 2>&1 9>&- &
  hook_watch=$!
  hook_status=0
  wait "$hook_child" || hook_status=$?
  hook_child=
  kill "$hook_watch" 2>/dev/null || true
  return "$hook_status"
}

hook_end() {
  trap '' 1 2 3 13 15
  if [ -n "$hook_watch" ]; then kill "$hook_watch" 2>/dev/null || true; fi
  if [ -n "$hook_child" ]; then
    # Stopped mid step. Ask the step to stop, and give it ten seconds to do so.
    kill -TERM -- "-$hook_child" 2>/dev/null || kill -TERM "$hook_child" 2>/dev/null || true
    ( sleep 10; kill -KILL -- "-$hook_child" 2>/dev/null ) </dev/null >/dev/null 2>&1 9>&- &
    hook_timer=$!
    wait "$hook_child" 2>/dev/null || true
    kill "$hook_timer" 2>/dev/null || true
  fi
  # Whatever a step left running in its group must not outlive the run.
  if [ -n "$hook_group" ]; then kill -KILL -- "-$hook_group" 2>/dev/null || true; fi
  if [ -n "$hook_dir" ]; then rm -rf "$hook_dir"; fi
}
