#!/usr/bin/env bash
# Checks a pull request's branch name and title against CONTRIBUTING.md.
# Usage: check-conventions.sh <branch> <title>
set -euo pipefail

branch=${1:?branch name required}
title=${2:?pull request title required}
types='feat|fix|docs|test|ci|refactor|perf|build|chore'
status=0

case "$branch" in
  dependabot/* | renovate/*)
    echo "Bot branch '$branch': conventions not checked."
    exit 0
    ;;
esac

fail() {
  echo "::error::$1"
  status=1
}

branch_re="^($types)/((TASK|BUG)-[0-9]{4,})-[a-z0-9]+(-[a-z0-9]+)*$"
if [[ $branch =~ $branch_re ]]; then
  branch_type=${BASH_REMATCH[1]}
  item=${BASH_REMATCH[2]}
  if [[ $item == BUG-* && $branch_type != fix ]]; then
    fail "Branch '$branch' is for a bug and must start with 'fix/'."
  fi
else
  fail "Branch '$branch' must be <type>/<item-ID>-<slug>, type one of ${types//|/, }; e.g. feat/TASK-0032-ship-skill."
  branch_type=''
  item=''
fi

title_re="^($types)(\([a-z0-9-]+\))?!?: .+ \(((TASK|BUG)-[0-9]{4,})\)$"
if [[ $title =~ $title_re ]]; then
  title_type=${BASH_REMATCH[1]}
  title_item=${BASH_REMATCH[3]}
  if [[ -n $branch_type && $title_type != "$branch_type" ]]; then
    fail "Title type '$title_type' does not match branch type '$branch_type'."
  fi
  if [[ -n $item && $title_item != "$item" ]]; then
    fail "Title item '$title_item' does not match branch item '$item'."
  fi
else
  fail "Title '$title' must be '<type>: <summary> (<item-ID>)'; e.g. 'feat: add the ship skill (TASK-0032)'."
fi

if ((status == 0)); then
  echo "Branch '$branch' and title '$title' follow the conventions."
fi
exit "$status"
