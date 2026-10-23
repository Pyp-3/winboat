SHELL := /bin/bash
BUN ?= $(shell command -v bun 2>/dev/null || printf '%s' '$(abspath ../tools/bin/bun)')
PREFIX ?= /usr/local
INSTALL_ROOT ?= /opt/winboat-workspace
DESTDIR ?=
BUILD_DIR ?= dist/linux-unpacked
export BUN

.PHONY: help deps check test build package install rollback sync
help:
	@printf '%s\n' 'make build       Install locked dependencies, check and build' 'make package     Bundle the existing build for installation' 'sudo make install Install the existing build globally' 'sudo make rollback Restore the previous installed build' 'make sync        Merge upstream and build in an isolated worktree'
deps:
	"$(BUN)" install --frozen-lockfile
check:
	"$(BUN)" run check

test:
	"$(BUN)" test
	bash tests/install.sh
	bash tests/sync.sh
	python3 -B tests/consolidation.py
build:
	bash scripts/build-local.sh
package:
	bash scripts/package.sh
install:
	bash scripts/install.sh install "$(BUILD_DIR)" "$(INSTALL_ROOT)" "$(PREFIX)" "$(DESTDIR)"
rollback:
	bash scripts/install.sh rollback "$(BUILD_DIR)" "$(INSTALL_ROOT)" "$(PREFIX)" "$(DESTDIR)"
sync:
	bash scripts/sync-upstream.sh
