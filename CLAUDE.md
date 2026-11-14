# CLAUDE.md

## Site summary

`README.md` has a section between `<!-- site-summary:start -->` and `<!-- site-summary:end -->`. A daily job copies it onto this project's card on https://mendus59.github.io, so it is the public description of the project.

Whenever a change adds, removes or noticeably changes something a user can see or do (a feature, the platforms it runs on, how to get or install it, the main tech), update that section in the same change:

- First line: one sentence saying what the project is, at most 160 characters.
- Then 1 to 6 bullets, one short sentence each, on what it does for the person using it. Lead with the most important.
- Plain text. Links and bold are stripped on the site, and nothing may follow the bullets inside the markers.
- Describe what is on `main` now, not plans.

The `Site summary` workflow checks the section's format on every pull request (`node sync-summaries.mjs --check README.md`, from the site repo's `scripts/`).
