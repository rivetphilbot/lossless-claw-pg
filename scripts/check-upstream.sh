#!/bin/bash
# Check for upstream lossless-claw updates against our fork
# Run during openclaw update process

UPSTREAM_PKG="@martian-engineering/lossless-claw"
FORK_DIR="$HOME/lossless-claw-pg"
FORK_VERSION=$(node -e "console.log(require('$FORK_DIR/package.json').version)")

# Get latest upstream version from npm
UPSTREAM_VERSION=$(npm view "$UPSTREAM_PKG" version 2>/dev/null)

if [ -z "$UPSTREAM_VERSION" ]; then
  echo "⚠️  Could not check upstream version for $UPSTREAM_PKG"
  exit 1
fi

if [ "$FORK_VERSION" = "$UPSTREAM_VERSION" ]; then
  echo "✅ lossless-claw fork is up to date (v$FORK_VERSION)"
  exit 0
else
  echo "🔄 lossless-claw upstream update available!"
  echo "   Fork:     v$FORK_VERSION"
  echo "   Upstream: v$UPSTREAM_VERSION"
  echo ""
  echo "   To update:"
  echo "   1. cd $FORK_DIR"
  echo "   2. Download upstream: npm pack $UPSTREAM_PKG@$UPSTREAM_VERSION"
  echo "   3. Extract and diff: diff -r src/ <extracted>/src/"
  echo "   4. Merge changes, keeping our PostgreSQL adapter"
  echo "   5. Update version in package.json"
  echo "   6. git commit -m 'Merge upstream v$UPSTREAM_VERSION'"
  echo "   7. Restart openclaw: systemctl --user restart openclaw"
  exit 2
fi
