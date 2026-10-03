.PHONY: install typecheck validate

install:
	npm install

# Needs .claude/types/ (not versioned): run /plugin-types inside a Claude Code session in this folder.
typecheck:
	npx tsc -p .

validate:
	claude plugin validate .
